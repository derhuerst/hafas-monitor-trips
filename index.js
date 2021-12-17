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
const redisOpts = require('./lib/redis-opts')
const noCache = require('./lib/no-cache')
const createWatchedTrips = require('./lib/watched-trips')
const tripsListSegmentsFilters = require('./lib/trips-list-segments-filters')
const createIsStopoverObsolete = require('./lib/is-stopover-obsolete')

const SECOND = 1000
const MINUTE = 60 * SECOND
const MAX_TILE_SIZE = 5 // in kilometers

// maximum nr. of trips returned by hafas.tripsByName()
// todo: move to hafas-client or determine dynamically
const TRIPS_BY_NAME_MAX_RESULTS = 1000

const TOO_MANY_QUEUED_MSG = `\
There are too many pending requests for the trips list/trip fetching \
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
	const fetchTripsListInterval = Math.max(
		Math.min(fetchTripsInterval, 3 * MINUTE),
		30 * SECOND,
	)
	debug('fetchTripsListInterval', fetchTripsListInterval)

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
	const monitoredTripsTotal = new Gauge({
		name: 'monitored_trips_total',
		help: 'nr. of trips being monitored',
		registers: [metricsRegistry],
	})
	const tripsListRefreshesPerSecond = new Gauge({
		name: 'trips_list_refreshes_second',
		help: 'how often the list of trips is refreshed',
		registers: [metricsRegistry],
	})
	const tripsRefreshesPerSecond = new Gauge({
		name: 'trips_refreshes_second',
		help: 'how often all trips are refreshed',
		registers: [metricsRegistry],
	})

	const out = new EventEmitter()

	const redis = new Redis(redisOpts)
	const watchedTrips = createWatchedTrips(redis, fetchTripsListInterval * 1.5, monitoredTripsTotal)
	const tripSeen = async (trips) => {
		for (const [id, lineName] of trips) debugTrips('trip seen', id, lineName)
		await watchedTrips.put(trips)
	}
	const tripObsolete = async (id) => {
		debugTrips('trip obsolete, removing', id)
		await watchedTrips.del(id)
	}

	const checkQueueLoad = throttle(() => {
		const tSinceFetchTripsList = Date.now() - tLastFetchTripsList
		const tSinceFetchAllTrips = Date.now() - tLastFetchTrips
		if (
			tSinceFetchTripsList > fetchTripsListInterval * 1.5 ||
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

	const fetchTripsListRecursively = async (lineNameOrFahrtNr = '*', tripsByNameOpts = {}) => {
		debugFetch('fetching trips list (segment)', lineNameOrFahrtNr, tripsByNameOpts)

		const t0 = Date.now()
		let trips
		try {
			trips = await hafas.tripsByName(lineNameOrFahrtNr, tripsByNameOpts)
		} catch (err) {
			if (err && err.code === 'NO_MATCH') {
				trips = []
			} else {
				if (err && err.isHafasError) {
					debugFetch('hafas error', err)
					hafasErrorsTotal.inc({call: 'radar'})
					out.emit('hafas-error', err)
				}
				if (err && err.code === 'ECONNRESET') {
					econnresetErrorsTotal.inc()
				}
				throw err
			}
		}
		onReqTime('tripsByName', Date.now() - t0)

		if (trips.length >= TRIPS_BY_NAME_MAX_RESULTS) {
			debugFetch(`maximum nr. of trips (${trips.length}), segmenting`)
			const segments = tripsListSegmentsFilters(hafas, lineNameOrFahrtNr, tripsByNameOpts, trips)

			const tripSets = await Promise.all(segments.map(({lineNameOrFahrtNr, opts}) => {
				return fetchTripsListRecursively(lineNameOrFahrtNr, opts)
			}))
			trips = [].concat(...tripSets)
		} else {
			debugFetch(`acceptable nr. of trips (${trips.length}), not segmenting`)
		}

		await tripSeen(trips.map(t => [t.id, t.line && t.line.name || '']))

		return trips
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

		// HAFAS' tripsByName() returns some trip IDs that, when fetched via
		// trip(), yield invalid trips (too sparse). We filter them out here.
		// e.g. on-demand trips
		if (
			!trip.origin || !trip.origin.type
			|| !trip.destination || !trip.destination.type
			|| !Array.isArray(trip.stopovers) || trip.stopovers.length === 0
		) {
			debugTrips('invalid trip', id, trip)
			await tripObsolete(id)
			return;
		}

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

		if (trip.currentLocation) {
			const loc = trip.currentLocation
			debugFetch(trip.id, trip.line && trip.line.name, loc.latitude, loc.longitude)

			const arrOf = (st) => {
				return Date.parse(st.arrival || st.plannedArrival || st.departure || st.plannedDeparture)
			}
			// todo: use dep time?
			const stopoversIdx = trip.stopovers.findIndex(st => arrOf(st) < Date.now())
			const m = {
				tripId: trip.id,
				direction: trip.direction,
				line: trip.line,
				location: trip.currentLocation,
				nextStopovers: stopoversIdx < 0
					? []
					: trip.stopovers.slice(stopoversIdx).slice(0, 3),
				frames: [],
			}
			out.emit('position', loc, m)
		}

		await tripSeen([
			[trip.id, trip.line && trip.line.name || '']
		])
	}

	let running = false
	let fetchTripsListTimer = null, tLastFetchTripsList = Date.now()
	let fetchTripsTimer = null, tLastFetchTrips = Date.now()

	const fetchTripsList = async () => {
		if (!running) return;

		debug('refreshing the trips list')
		tLastFetchTripsList = Date.now()
		let trips = await fetchTripsListRecursively()

		tripsListRefreshesPerSecond.set(1000 / (Date.now() - tLastFetchTripsList))
		tLastFetchTripsList = Date.now()
		debug('done refreshing the trips list')

		// HAFAS' tripsByName() also returns invalid trips. We filter them out here.
		trips = trips.filter(t => t.id && t.line && t.line.name)

		await Promise.all(trips.map(async (t) => {
			await tripSeen(t.id, t.line && t.line.name || '')
		}))

		if (running) {
			const tNext = Math.max(100, fetchTripsListInterval - (Date.now() - tLastFetchTripsList))
			fetchTripsListTimer = setTimeout(fetchTripsList, tNext)
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

		fetchTripsList()
		.then(fetchAllTrips)
		// .catch(() => {}) // silence rejection
	}

	const stop = () => {
		if (!running) return;
		debug('stopping monitor')
		running = false

		redis.quit()
		clearTimeout(fetchTripsListTimer)
		fetchTripsListTimer = null
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
