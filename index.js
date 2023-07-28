import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)

import {ok} from 'node:assert'
import createDebug from 'debug'
import {EventEmitter} from 'node:events'
import Redis from 'ioredis'
import {
	register as globalMetricsRegistry,
	Counter, Summary, Gauge,
} from 'prom-client'
import {createHash} from 'node:crypto'
import distance from '@turf/distance'
import {redisOpts} from './lib/redis-opts.js'
import {findMaxRadarResults} from './lib/find-max-radar-results.js'
import {noCache} from './lib/no-cache.js'
const pkg = require('./package.json')

const debug = createDebug('hafas-monitor-trips')
const debugFetch = createDebug('hafas-monitor-trips:fetch')

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
		maxRadarResults: _maxRadarResults,
	} = {
		fetchTilesInterval: MINUTE,
		hafasRadarOpts: {},
		metricsRegistry: globalMetricsRegistry,
		maxRadarResults: null,
		...opt,
	}

	let currentFetchTilesInterval
	if ('function' === typeof fetchTilesInterval) {
		currentFetchTilesInterval = fetchTilesInterval
		if ('number' !== typeof currentFetchTilesInterval()) {
			throw new TypeError('opt.fetchTilesInterval() must return a number')
		}
	} else if ('number' === typeof fetchTilesInterval) {
		currentFetchTilesInterval = () => fetchTilesInterval
	} else {
		throw new TypeError('opt.fetchTilesInterval must be a number of a function')
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
	const movementsFetchedTotal = new Counter({
		name: 'movements_fetched_total',
		help: 'nr. of movements fetched from HAFAS',
		registers: [metricsRegistry],
	})
	const fetchAllMovementsTotal = new Counter({
		name: 'fetch_all_movements_total',
		help: 'how often all movements have been fetched',
		registers: [metricsRegistry],
	})
	const fetchAllMovementsDuration = new Gauge({
		name: 'fetch_all_movements_duration_seconds',
		help: 'time that fetching all movements currently takes',
		registers: [metricsRegistry],
	})

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)

	const onReqTime = (call, reqTime) => {
		hafasRequestsTotal.inc({call})
		hafasResponseTime.observe({call}, reqTime / 1000)
	}

	const onMovement = (m) => {
		movementsFetchedTotal.inc()
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
		// todo: this very unprecise, find sth better
		if (err && err instanceof TypeError) {
			debugFetch('hafas-client error', err)
			out.emit('hafas-client-error', err)
			return;
		}
		if (err && err.code === 'ECONNRESET') {
			econnresetErrorsTotal.inc()
		}
		throw err
	}

	// todo: make it abortable
	// todo: pass in hafasRadarOpts
	const pMaxRadarResults = Number.isInteger(_maxRadarResults)
		? Promise.resolve(_maxRadarResults)
		: findMaxRadarResults(hafas, bbox, redis, onReqTime, onMovement)
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
				const res = await hafas.radar(bbox, {
					results: 1000, duration: 0, frames: 0, polylines: false,
					// todo: `opt.language`
					...hafasRadarOpts,
					...noCache,
				})
				movements = res.movements
			} catch (err) {
				// emits HAFAS-specific errors, throws all others
				handleFetchError('radar', err)
				return; // todo: retry
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
	let fetchTilesTimer = null, tLastFetchTiles

	const fetchAllTiles = async () => {
		if (!running) return;
		debug('refreshing all tiles')
		tLastFetchTiles = Date.now()

		try {
			await fetchRecursively()
		} catch (err) {
			out.emit('error', err)
		}

		const dur = (Date.now() - tLastFetchTiles) / 1000
		debug(`done refreshing tiles in ${dur}s`)
		fetchAllMovementsDuration.set(dur)
		fetchAllMovementsTotal.inc()

		if (running) {
			const fetchTilesInterval = currentFetchTilesInterval()
			const tNext = Math.max(100, fetchTilesInterval - dur * 1000)
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

	const stop = () => {
		if (!running) return;
		debug('stopping monitor')
		running = false

		clearTimeout(fetchTilesTimer)
		fetchTilesTimer = null
		out.emit('stop')
	}

	const quit = () => {
		stop()
		redis.quit()
	}

	// todo: optionally, don't do this right away but in `Date.now() % interval` ms?
	setImmediate(start)

	out.hafas = hafas
	out.start = start
	out.stop = stop
	out.quit = quit

	Object.defineProperty(out, 'bbox', {value: bbox})
	Object.defineProperty(out, 'metricsRegistry', {value: metricsRegistry})
	Object.defineProperty(out, 'redis', {value: redis})
	Object.defineProperty(out, 'handleFetchError', {value: handleFetchError})
	Object.defineProperty(out, 'onReqTime', {value: onReqTime})

	return out
}

export {
	createMonitor,
}
