'use strict'

const {ok} = require('assert')
const debug = require('debug')('hafas-monitor-trips')
const debugFetch = require('debug')('hafas-monitor-trips:fetch')
const {EventEmitter} = require('events')
const Redis = require('ioredis')
const {
	register: globalMetricsRegistry,
	Counter, Summary, Gauge,
} = require('prom-client')
const {createHash} = require('crypto')
const distance = require('@turf/distance').default
const redisOpts = require('./lib/redis-opts')
const findMaxRadarResults = require('./lib/find-max-radar-results')
const noCache = require('./lib/no-cache')
const pkg = require('./package.json')

const SECOND = 1000
const MINUTE = 60 * SECOND

const BBOX_EXPECTED_RESULTS_NS = pkg.version.split('.')[0] + ':expected-nr-of-results'
// We assume that the amount of vehicles varies over the day (and therefore the
// expected nr. of vehicles within a bbox), but not very quickly.
const BBOX_EXPECTED_RESULTS_TTL = 3 * 60 * 60 // 3h

const createMonitor = (hafas, bbox, opt) => {
	if (!hafas) {
		throw new Error('Invalid HAFAS client passed.')
	}
	if ('function' !== typeof hafas.radar) {
		throw new TypeError('hafas.radar must be a function.')
	}
	ok(hafas.profile.endpoint, 'hafas.profile.endpoint must not be empty')
	const endpointHash = createHash('sha256')
	.update(hafas.profile.endpoint)
	.digest('base64')
	.slice(0, 10)

	const {
		fetchTilesInterval,
		hafasRadarOpts,
		metricsRegistry,
	} = {
		fetchTilesInterval: MINUTE,
		hafasRadarOpts: {},
		metricsRegistry: globalMetricsRegistry,
		...opt,
	}

	// metrics
	const hafasRequestsTotal = new Counter({
		name: 'hafas_reqs_total',
		help: 'nr. of HAFAS requests',
		registers: [metricsRegistry],
		labelNames: ['call'],
	})
	const hafasErrorsTotal = new Counter({
		name: 'hafas_errors_total',
		help: 'nr. of failed HAFAS requests',
		registers: [metricsRegistry],
		labelNames: ['call'],
	})
	const econnresetErrorsTotal = new Counter({
		name: 'econnreset_errors_total',
		help: 'nr. of requests failed with ECONNRESET',
		registers: [metricsRegistry],
	})
	const hafasResponseTime = new Summary({
		name: 'hafas_response_time_seconds',
		help: 'HAFAS response time',
		registers: [metricsRegistry],
		// todo: use sliding window via maxAgeSeconds & ageBuckets?
		labelNames: ['call'],
	})
	const tilesFetchedTotal = new Counter({
		name: 'tiles_fetched_total',
		help: 'nr. of tiles fetched from HAFAS',
		registers: [metricsRegistry],
	})
	const tilesRefreshesPerSecond = new Gauge({
		name: 'tiles_refreshes_second',
		help: 'how often the list of trips is refreshed',
		registers: [metricsRegistry],
	})
	const fetchMovementsDuration = new Summary({
		name: 'fetch_movements_duration_seconds',
		help: 'time that fetching all movements took',
		registers: [metricsRegistry],
		// todo: use sliding window via maxAgeSeconds & ageBuckets?
	})

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)

	const onReqTime = (call, reqTime) => {
		hafasRequestsTotal.inc({call})
		hafasResponseTime.observe({call}, reqTime / 1000)
	}

	const onMovement = (m) => {
		const loc = m.location
		out.emit('position', loc, m)
	}

	const handleFetchError = (call, err) => {
		if (err && err.isHafasError) {
			debugFetch('hafas error', err)
			hafasErrorsTotal.inc({call})
			out.emit('hafas-error', err)
			return;
		}
		if (err && err.code === 'ECONNRESET') {
			econnresetErrorsTotal.inc()
		}
		throw err
	}

	// todo: make it abortable
	// todo: pass in hafasRadarOpts
	const pMaxRadarResults = findMaxRadarResults(hafas, bbox, redis, onReqTime, onMovement)
	pMaxRadarResults
	.catch(err => handleFetchError('radar', err))
	.catch(err => out.emit('error', err))

	// normalize for better caching
	const _bbox = {
		north: Math.round(bbox.north * 10000) / 10000,
		west: Math.round(bbox.west * 10000) / 10000,
		south: Math.round(bbox.south * 10000) / 10000,
		east: Math.round(bbox.east * 10000) / 10000,
	}
	const _width = distance(
		{type: 'Point', coordinates: [bbox.west, bbox.north]},
		{type: 'Point', coordinates: [bbox.east, bbox.north]},
	)
	const _height = distance(
		{type: 'Point', coordinates: [bbox.west, bbox.north]},
		{type: 'Point', coordinates: [bbox.west, bbox.south]},
	)
	const _splitHorizontally = _width < _height

	const fetchRecursively = async (bbox = _bbox, splitHorizontally = _splitHorizontally) => {
		const cacheKey = [
			BBOX_EXPECTED_RESULTS_NS,
			endpointHash,
			bbox.north, bbox.west, bbox.south, bbox.east,
		].join(':')

		const maxResults = await pMaxRadarResults
		let nrOfResults = await redis.get(cacheKey)
		nrOfResults = nrOfResults
			? parseInt(nrOfResults)
			: NaN

		let movements
		if (nrOfResults >= maxResults) {
			debugFetch(`expecting too many results because of cached nr. (${nrOfResults})`)
		} else {
			// only fetch bbox if we don't expect too many movements
			debugFetch('fetching bounding box', bbox)
			const t0 = Date.now()
			try {
				movements = await hafas.radar(bbox, {
					results: 1000, duration: 0, frames: 0, polylines: false,
					// todo: `opt.language`
					...hafasRadarOpts,
					...noCache,
				})
			} catch (err) {
				handleFetchError('radar', err)
			}
			onReqTime('radar', Date.now() - t0)
			tilesFetchedTotal.inc()

			for (const m of movements) onMovement(m)

			nrOfResults = movements.length
			if (nrOfResults >= maxResults) {
				debugFetch(`too many results (${movements.length})`)
				await redis.setex(cacheKey, BBOX_EXPECTED_RESULTS_TTL, movements.length + '')
			}
		}

		if (nrOfResults >= maxResults) {
			// this is accurate enough for our use case
			let bboxA, bboxB
			if (splitHorizontally) {
				const border = Math.round((bbox.east - (bbox.east - bbox.west) / 2) * 10000) / 10000
				bboxA = {...bbox, east: border}
				bboxB = {...bbox, west: border}
			} else {
				const border = Math.round((bbox.north - (bbox.north - bbox.south) / 2) * 10000) / 10000
				bboxA = {...bbox, south: border}
				bboxB = {...bbox, north: border}
			}

			debugFetch('recursing with split bounding boxes', bboxA, bboxB)
			await Promise.all([
				fetchRecursively(bboxA, !splitHorizontally),
				fetchRecursively(bboxB, !splitHorizontally),
			])
		}
	}

	let running = false
	let fetchTilesTimer = null, tLastFetchTiles = Date.now()

	const fetchAllTiles = async () => {
		if (!running) return;
		tilesRefreshesPerSecond.set(1000 / (Date.now() - tLastFetchTiles))
		debug('refreshing all tiles')
		tLastFetchTiles = Date.now()

		try {
			await fetchRecursively()
		} catch (err) {
			out.emit('error', err)
		}

		debug('done refreshing tiles')
		if (running) {
			const tNext = Math.max(100, fetchTilesInterval - (Date.now() - tLastFetchTiles))
			fetchTilesTimer = setTimeout(fetchAllTiles, tNext)
		}
	}

	const start = () => {
		if (running) return false;
		debug('starting monitor')
		running = true

		pMaxRadarResults
		.then(fetchAllTiles)
		.catch(err => out.emit('error', err))
	}

	// todo [breaking]: rename to stop()
	const pause = () => {
		if (!running) return;
		debug('stopping monitor')
		running = false

		clearTimeout(fetchTilesTimer)
		fetchTilesTimer = null
		out.emit('stop')
	}

	// todo [breaking]: rename to quit()
	const stop = () => {
		pause()
		redis.quit()
	}

	setImmediate(start)

	out.hafas = hafas
	out.start = start
	out.pause = pause
	out.stop = stop

	Object.defineProperty(out, 'bbox', {value: bbox})
	Object.defineProperty(out, 'metricsRegistry', {value: metricsRegistry})
	Object.defineProperty(out, 'handleFetchError', {value: handleFetchError})
	Object.defineProperty(out, 'onReqTime', {value: onReqTime})

	return out
}

module.exports = createMonitor
