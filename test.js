import {createVbbHafas as createHafas} from 'vbb-hafas'
import * as a from 'node:assert'
import {Registry} from 'prom-client'
import {expandingBoundingBoxes} from './lib/find-max-radar-results.js'
import {createMonitor} from './index.js'
import {
	addTripsFetchingToMonitor as fetchTrips,
} from './fetch-trips/index.js'

a.deepStrictEqual(
	Array.from(expandingBoundingBoxes({
		north: 54.52,
		west: 6.54,
		south: 51.29,
		east: 6.65,
	}))
	.map(({north, west, south, east}, i) => [north, west, south, east]),
	[
		[53.0665,6.5895,52.7435,6.6005],
		[53.1473,6.5868,52.6628,6.6032],
		[53.2684,6.5826,52.5416,6.6074],
		[53.4501,6.5764,52.3599,6.6136],
		[53.7226,6.5672,52.0874,6.6228],
		[54.1314,6.5532,51.6786,6.6368],
		[54.7446,6.5324,51.0654,6.6576],
		[55.6644,6.501, 50.1456,6.689 ],
		[57.0441,6.454, 48.7659,6.736 ],
		[59.1136,6.3836,46.6964,6.8064],
		[62.2179,6.2778,43.5921,6.9122],
		[66.8744,6.1193,38.9356,7.0707],
	],
)

const METRICS = [
	'hafas_reqs_total',
	'hafas_errors_total',
	'econnreset_errors_total',
	'hafas_response_time_seconds',
	'fetch_all_movements_duration_seconds',
	'movements_fetched_total',
	'fetch_all_movements_total',
	'tiles_fetched_total',
]

const bbox = {north: 52.52, west: 13.36, south: 52.5, east: 13.39}
const hafas = createHafas('hafas-monitor-trips test')

const registry = new Registry()

const monitor = createMonitor(hafas, bbox, {
	fetchTripsInterval: () => 4 * 1000,
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
