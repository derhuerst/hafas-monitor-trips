'use strict'

const debug = require('debug')('hafas-monitor-trips')
const debugFetch = require('debug')('hafas-monitor-trips:fetch')
const {EventEmitter} = require('events')
const Redis = require('ioredis')
const {
	register: globalMetricsRegistry,
	Counter, Summary, Gauge,
} = require('prom-client')
const computeTiles = require('./lib/compute-tiles')
const redisOpts = require('./lib/redis-opts')
const noCache = require('./lib/no-cache')

const SECOND = 1000
const MINUTE = 60 * SECOND
const MAX_TILE_SIZE = 5 // in kilometers

const createMonitor = (hafas, bbox, opt) => {
	if (!hafas) {
		throw new Error('Invalid HAFAS client passed.')
	}
	if ('function' !== typeof hafas.radar) {
		throw new TypeError('hafas.radar must be a function.')
	}

	const {
		fetchTilesInterval,
		maxTileSize,
		hafasRadarOpts,
		metricsRegistry,
	} = {
		fetchTilesInterval: MINUTE,
		maxTileSize: 5, // km
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
	const monitoredTilesTotal = new Gauge({
		name: 'monitored_tiles_total',
		help: 'nr. of tiles being monitored',
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

	const tiles = computeTiles(bbox, {maxTileSize})
	monitoredTilesTotal.set(tiles.length)
	debug('tiles', tiles)

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)

	const onReqTime = (call, reqTime) => {
		hafasRequestsTotal.inc({call})
		hafasResponseTime.observe({call}, reqTime / 1000)
	}

	const fetchTile = async (tile) => {
		debugFetch('fetching tile', tile)

		const t0 = Date.now()
		let movements
		try {
			movements = await hafas.radar(tile, {
				results: 1000, duration: 0, frames: 0, polylines: false,
				// todo: `opt.language`
				...hafasRadarOpts,
				...noCache,
			})
		} catch (err) {
			if (err && err.isHafasError) {
				debugFetch('hafas error', err)
				hafasErrorsTotal.inc({call: 'radar'})
				out.emit('hafas-error', err)
				return;
			}
			if (err && err.code === 'ECONNRESET') {
				econnresetErrorsTotal.inc()
			}
			throw err
		}
		onReqTime('radar', Date.now() - t0)

		for (const m of movements) {
			const loc = m.location
			debugFetch(m.tripId, m.line && m.line.name, loc.latitude, loc.longitude)

			out.emit('position', loc, m)
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
			await Promise.all(tiles.map(fetchTile))
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

		fetchAllTiles()
		.catch(() => {}) // silence rejection
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
