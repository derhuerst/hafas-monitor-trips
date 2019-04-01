'use strict'

const {polygon, point} = require('@turf/helpers')
const squareGrid = require('@turf/square-grid').default
const debug = require('debug')('hafas-monitor-trips')
const createAvgWindow = require('live-moving-average')
const PQueue = require('p-queue')
const throttle = require('lodash.throttle')
const {EventEmitter} = require('events')
const isWithin = require('@turf/boolean-within').default

const MINUTE = 60 * 1000
const MAX_TILE_SIZE = 5000 // 5km

const roundTo = (x, d) => parseFloat(x.toFixed(d))
const computeTiles = (bbox, cellSize) => {
	const grid = squareGrid([bbox.west, bbox.south, bbox.east, bbox.north], 1000, {units: 'meters'})
	return grid.features.map((f) => {
		const coords = f.geometry.coordinates[0]
		return {
			north: roundTo(coords[2][1], 4),
			west: roundTo(coords[0][0], 4),
			south: roundTo(coords[0][1], 4),
			east: roundTo(coords[2][0], 4)
		}
	})
}

const createMonitor = (hafas, bbox, interval, concurrency = 8) => {
	if (!hafas || 'function' !== typeof hafas.radar || 'function' !== typeof hafas.trip) {
		throw new Error('Invalid HAFAS client passed.')
	}

	if ('number' !== typeof bbox.north) throw new TypeError('bbox.north must be a number.')
	if ('number' !== typeof bbox.west) throw new TypeError('bbox.west must be a number.')
	if ('number' !== typeof bbox.south) throw new TypeError('bbox.south must be a number.')
	if ('number' !== typeof bbox.east) throw new TypeError('bbox.east must be a number.')
	if (bbox.north <= bbox.south) throw new Error('bbox.north must be larger than bbox.south.')
	if (bbox.east <= bbox.west) throw new Error('bbox.east must be larger than bbox.west.')
	const tiles = computeTiles(bbox)

	const discoverInterval = Math.min(interval, 3 * MINUTE)

	const queue = new PQueue({concurrency: 8})
	const trips = new Map()

	let nrOfTrips = 0, reqs = 0
	const avgReqDuration = createAvgWindow(10, 300)
	const reportStats = throttle(() => { // todo: throttle
		out.emit('stats', {
			totalReqs: reqs, avgReqDuration: avgReqDuration.get(), queuedReqs: queue.size,
			trips: nrOfTrips
		})
	}, 1000)
	const onReqTime = (reqTime) => {
		reqs++
		avgReqDuration.push(reqTime)
		reportStats()
	}

	const fetchTile = (tile) => async () => {
		let movements
		try {
			const t0 = Date.now()
			movements = await hafas.radar(tile, {
				results: 1000, frames: 0, polylines: false // todo: `opt.language`
			})
			onReqTime(Date.now() - t0)
		} catch (err) {
			out.emit('error', err)
			return
		}

		for (const m of movements) {
			out.emit('position', m.location, m)

			if (trips.has(m.tripId)) continue
			trips.set(m.tripId, m.line && m.line.name || 'foo')
			nrOfTrips++
			out.emit('new-trip', m.tripId, m)
			// todo: processs `m.nextStopovers`
		}
	}

	const fetchAllTiles = async () => {
		try {
			await queue.addAll(tiles.map(fetchTile), {priority: 1})
		} catch (err) {
			out.emit('error', err)
		}
		setTimeout(fetchAllTiles, discoverInterval)
		fetchAllTrips()
	}
	setImmediate(fetchAllTiles)

	const bboxAsRectangle = polygon([[
		[bbox.west, bbox.north],
		[bbox.east, bbox.north],
		[bbox.east, bbox.south],
		[bbox.west, bbox.south],
		[bbox.west, bbox.north] // close
	]])
	const isStopoverObsolete = (s) => {
		const when = s.arrival || s.scheduledArrival || s.departure || s.scheduledDeparture
		const inTheFuture = when && new Date(when) > Date.now()
		if (inTheFuture) {
			const stopLoc = point([s.stop.location.longitude, s.stop.location.latitude])
			if (isWithin(stopLoc, bboxAsRectangle)) return true
		}
		return false
	}

	// todo: remove trip if not found
	const fetchTrip = (tripId, lineName) => async () => {
		let trip
		try {
			const t0 = Date.now()
			trip = await hafas.trip(tripId, lineName) // todo: `opt.language`
			onReqTime(Date.now() - t0)
		} catch (err) {
			out.emit('error', err)
			return
		}
		if (trip.stopovers.every(isStopoverObsolete)) {
			trips.delete(tripId)
			nrOfTrips--
			out.emit('trip-obsolete', tripId, trip)
			return
		}

		out.emit('trip', trip)
		for (const stopover of trip.stopovers) out.emit('stopover', stopover, trip)
	}

	const fetchAllTrips = throttle(() => {
		for (const [tripId, lineName] of trips.entries()) {
			queue.add(fetchTrip(tripId, lineName)) // todo: rejection?
		}
		setTimeout(fetchAllTrips, interval)
	}, interval)
	setImmediate(fetchAllTrips)

	// todo: queue on error?
	const out = new EventEmitter()
	// todo: stop function
	return out
}

module.exports = createMonitor
