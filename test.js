'use strict'

const createHafas = require('vbb-hafas')
const a = require('assert')
const {Registry} = require('prom-client')
const createMonitor = require('.')
const fetchTrips = require('./fetch-trips')

const METRICS = [
	'hafas_reqs_total',
	'hafas_errors_total',
	'econnreset_errors_total',
	'hafas_response_time_seconds',
	'fetch_movements_duration_seconds',
	'monitored_tiles_total',
]

const bbox = {north: 52.52, west: 13.36, south: 52.5, east: 13.39}
const hafas = createHafas('hafas-monitor-trips test')

const registry = new Registry()

const monitor = createMonitor(hafas, bbox, {
	fetchTripsInterval: 4 * 1000,
	metricsRegistry: registry,
})
fetchTrips(monitor)

a.strictEqual(monitor.hafas, hafas)

monitor.once('error', (err) => {
	console.error(err)
	process.exit(1)
})

const spy = (fn) => {
	const _spy = (...args) => {
		_spy.called = true
		return fn(...args)
	}
	return _spy
}

const validateTrip = (t) => {
	a.ok(t.id)
	a.ok(t.line)
	if (t.direction !== null) a.ok(t.direction)
}

const onStopover = spy((s, t) => {
	a.ok(s.stop)
	a.ok('arrival' in s)
	a.ok('plannedArrival' in s)
	a.ok('arrivalDelay' in s)
	a.ok('arrivalPlatform' in s)
	a.ok('departure' in s)
	a.ok('plannedDeparture' in s)
	a.ok('departureDelay' in s)
	a.ok('departurePlatform' in s)

	a.ok(s.tripId)
	a.ok(s.line)
	validateTrip(t)
})
monitor.on('stopover', onStopover)

const onTrip = spy(validateTrip)
monitor.on('trip', onTrip)

const onPosition = spy((l, m) => {
	a.ok('latitude' in l)
	a.ok('longitude' in l)

	a.ok(m.tripId)
	a.ok(m.line)
	a.ok(m.direction)
})
monitor.on('position', onPosition)

setTimeout(() => {
	a.ok(onStopover.called, 'stopover not emitted')
	a.ok(onTrip.called, 'trip not emitted')
	a.ok(onPosition.called, 'position not emitted')

	const metrics = registry.getMetricsAsArray()
	for (const name of METRICS) {
		a.ok(metrics.find(m => m.name === name), name + ' metric not defined/exposed')
	}

	// teardown
	monitor.removeListener('stopover', onStopover)
	monitor.removeListener('trip', onTrip)
	monitor.removeListener('position', onPosition)

	console.info('seems to work ✔︎')
	process.exit()
}, 11 * 1000)
