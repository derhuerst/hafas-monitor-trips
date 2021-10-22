'use strict'

const debug = require('debug')('hafas-monitor-trips')
const debugTrips = require('debug')('hafas-monitor-trips:trips')
const debugFetch = require('debug')('hafas-monitor-trips:fetch')
const throttle = require('lodash.throttle')
const {EventEmitter} = require('events')
const Redis = require('ioredis')
const {
	register: globalMetricsRegistry,
	Counter, Summary, Gauge,
} = require('prom-client')
const computeTiles = require('./lib/compute-tiles')
const redisOpts = require('./lib/redis-opts')
const noCache = require('./lib/no-cache')
const createWatchedTrips = require('./lib/watched-trips')
const createIsStopoverObsolete = require('./lib/is-stopover-obsolete')

const SECOND = 1000
const MINUTE = 60 * SECOND
const MAX_TILE_SIZE = 5 // in kilometers

const TOO_MANY_QUEUED_MSG = `\
There are too many pending requests for the tile/trip fetching \
intervals to be adhered to. Consider monitoring a smaller bbox or \
increasing the request throughput.\
`

const createMonitor = (hafas, bbox, opt) => {
	if (!hafas || 'function' !== typeof hafas.radar || 'function' !== typeof hafas.trip) {
		throw new Error('Invalid HAFAS client passed.')
	}

	const {
		fetchTripsInterval,
		maxTileSize,
		hafasRadarOpts,
		hafasTripOpts,
		metricsRegistry,
	} = {
		fetchTripsInterval: MINUTE,
		maxTileSize: 5, // km
		hafasRadarOpts: {},
		hafasTripOpts: {},
		metricsRegistry: globalMetricsRegistry,
		...opt,
	}
	const fetchTilesInterval = Math.max(
		Math.min(fetchTripsInterval, 3 * MINUTE),
		30 * SECOND,
	)
	debug('fetchTilesInterval', fetchTilesInterval)

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
	const monitoredTripsTotal = new Gauge({
		name: 'monitored_trips_total',
		help: 'nr. of trips being monitored',
		registers: [metricsRegistry],
	})
	const tilesRefreshesPerSecond = new Gauge({
		name: 'tiles_refreshes_second',
		help: 'how often the list of trips is refreshed',
		registers: [metricsRegistry],
	})
	const tripsRefreshesPerSecond = new Gauge({
		name: 'trips_refreshes_second',
		help: 'how often all trips are refreshed',
		registers: [metricsRegistry],
	})

	const tiles = computeTiles(bbox, {maxTileSize})
	monitoredTilesTotal.set(tiles.length)
	debug('tiles', tiles)

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)
	const watchedTrips = createWatchedTrips(redis, fetchTilesInterval * 1.5, monitoredTripsTotal)
	const tripSeen = async (trips) => {
		for (const [id, lineName] of trips) debugTrips('trip seen', id, lineName)
		await watchedTrips.put(trips)
	}
	const tripObsolete = async (id) => {
		debugTrips('trip obsolete, removing', id)
		await watchedTrips.del(id)
	}

	const checkQueueLoad = throttle(() => {
		const tSinceFetchAllTiles = Date.now() - tLastFetchTiles
		const tSinceFetchAllTrips = Date.now() - tLastFetchTrips
		if (
			tSinceFetchAllTiles > fetchTilesInterval * 1.5 ||
			tSinceFetchAllTrips > fetchTripsInterval * 1.5
		) {
			out.emit('too-many-queued')
			debug(TOO_MANY_QUEUED_MSG)
		}
	}, 1000)
	const onReqTime = (call, reqTime) => {
		hafasRequestsTotal.inc({call})
		hafasResponseTime.observe({call}, reqTime / 1000)

		checkQueueLoad()
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

		await tripSeen(movements.map(m => [m.tripId, m.line && m.line.name || '']))
	}

	const isStopoverObsolete = createIsStopoverObsolete(bbox)
	const fetchTrip = async (id, lineName) => {
		debugFetch('fetching trip', id, lineName)

		const t0 = Date.now()
		let trip
		try {
			// todo: remove trip if not found
			trip = await hafas.trip(id, lineName, {
				stopovers: true,
				polyline: false,
				entrances: false,
				// todo: `opt.language`
				...hafasTripOpts,
				...noCache,
			})
		} catch (err) {
			if (err && err.isHafasError) {
				debugFetch('hafas error', err)
				hafasErrorsTotal.inc({call: 'trip'})
				out.emit('hafas-error', err)
				return;
			}
			if (err && err.code === 'ECONNRESET') {
				econnresetErrorsTotal.inc()
			}
			throw err
		}
		onReqTime('trip', Date.now() - t0)

		if (trip.stopovers.every(isStopoverObsolete)) {
			const st = trip.stopovers.map(s => [s.stop.location, s.arrival || s.plannedArrival])
			debugTrips('trip obsolete', id, lineName, st)
			await tripObsolete(id)
			return;
		}

		out.emit('trip', trip)
		for (const stopover of trip.stopovers) {
			out.emit('stopover', {
				tripId: trip.id,
				line: trip.line,
				...stopover
			}, trip)
		}

		await tripSeen([
			[trip.id, trip.line && trip.line.name || '']
		])
	}

	let running = false
	let fetchTilesTimer = null, tLastFetchTiles = Date.now()
	let fetchTripsTimer = null, tLastFetchTrips = Date.now()

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

	const fetchAllTrips = async () => {
		if (!running) return;
		tripsRefreshesPerSecond.set(1000 / (Date.now() - tLastFetchTrips))
		debug('refreshing all trips')
		tLastFetchTrips = Date.now()

		try {
			const jobs = []
			for await (const [id, lineName] of watchedTrips.entries()) {
				jobs.push(fetchTrip(id, lineName))
			}
			await Promise.all(jobs)
		} catch (err) {
			out.emit('error', err)
		}

		debug('done refreshing trips')
		if (running) {
			const tNext = Math.max(100, fetchTripsInterval - (Date.now() - tLastFetchTrips))
			fetchTripsTimer = setTimeout(fetchAllTrips, tNext)
		}
	}

	const start = () => {
		if (running) return false;
		debug('starting monitor')
		running = true

		fetchAllTiles()
		.then(fetchAllTrips)
		.catch(() => {}) // silence rejection
	}

	const stop = () => {
		if (!running) return;
		debug('stopping monitor')
		running = false

		redis.quit()
		clearTimeout(fetchTilesTimer)
		fetchTilesTimer = null
		clearTimeout(fetchTripsTimer)
		fetchTripsTimer = null
		out.emit('stop')
	}

	setImmediate(start)

	out.hafas = hafas
	out.start = start
	out.stop = stop
	return out
}

module.exports = createMonitor
