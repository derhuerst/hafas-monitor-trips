'use strict'

const debug = require('debug')('hafas-monitor-trips')
const debugTrips = require('debug')('hafas-monitor-trips:trips')
const debugFetch = require('debug')('hafas-monitor-trips:fetch')
const throttle = require('lodash.throttle')
const {EventEmitter} = require('events')
const Redis = require('ioredis')
const computeTiles = require('./lib/compute-tiles')
const redisOpts = require('./lib/redis-opts')
const noCache = require('./lib/no-cache')
const createReqCounter = require('./lib/req-counter')
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
	} = {
		fetchTripsInterval: MINUTE,
		maxTileSize: 5, // km
		...opt,
	}
	const fetchTilesInterval = Math.max(
		Math.min(fetchTripsInterval, 3 * MINUTE),
		30 * SECOND,
	)
	debug('fetchTilesInterval', fetchTilesInterval)

	const tiles = computeTiles(bbox, {maxTileSize})
	debug('tiles', tiles)

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)
	const watchedTrips = createWatchedTrips(redis, fetchTilesInterval * 1.5)
	const tripSeen = async (id, lineName) => {
		debugTrips('trip seen', id, lineName)
		await watchedTrips.put(id, lineName)
	}
	const tripObsolete = async (id) => {
		debugTrips('trip obsolete, removing', id)
		await watchedTrips.del(id)
	}

	const reqCounter = createReqCounter()
	const reportStats = throttle(async () => {
		const tSinceFetchAllTiles = Date.now() - tLastFetchTiles
		const tSinceFetchAllTrips = Date.now() - tLastFetchTrips
		out.emit('stats', {
			...reqCounter.getStats(),
			running,
			nrOfTrips: await watchedTrips.count(),
			nrOfTiles: tiles.length,
			tSinceFetchAllTiles, tSinceFetchAllTrips,
		})
		if (
			tSinceFetchAllTiles > fetchTilesInterval * 1.5 ||
			tSinceFetchAllTrips > fetchTripsInterval * 1.5
		) {
			out.emit('too-many-queued')
			debug(TOO_MANY_QUEUED_MSG)
		}
	}, 1000)
	const onReqTime = (reqTime) => {
		reqCounter.onReqTime(reqTime)
		reportStats().catch(err => out.emit('error', err))
	}

	const fetchTile = async (tile) => {
		debugFetch('fetching tile', tile)

		const t0 = Date.now()
		const movements = await hafas.radar(tile, {
			results: 1000, duration: 0, frames: 0, polylines: false,
			// todo: `opt.language`
			...noCache,
		})
		onReqTime(Date.now() - t0)

		for (const m of movements) {
			const loc = m.location
			debugFetch(m.tripId, m.line && m.line.name, loc.latitude, loc.longitude)

			out.emit('position', loc, m)
		}

		await Promise.all(movements.map(async (m) => {
			await tripSeen(m.tripId, m.line && m.line.name || '')
		}))
	}

	const isStopoverObsolete = createIsStopoverObsolete(bbox)
	const fetchTrip = async (id, lineName) => {
		debugFetch('fetching trip', id, lineName)

		const t0 = Date.now()
		// todo: remove trip if not found
		const trip = await hafas.trip(id, lineName, {
			// todo: `opt.language`
			...noCache,
		})
		onReqTime(Date.now() - t0)

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

		await tripSeen(trip.id, trip.line && trip.line.name || '')
	}

	let running = false
	let fetchTilesTimer = null, tLastFetchTiles = -Infinity
	let fetchTripsTimer = null, tLastFetchTrips = -Infinity

	const fetchAllTiles = async () => {
		if (!running) return;
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
