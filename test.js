'use strict'

const createHafas = require('vbb-hafas')
const a = require('assert')
const createMonitor = require('.')

const bbox = {north: 52.52, west: 13.36, south: 52.5, east: 13.39}
const hafas = createHafas('hafas-monitor-trips example')
const monitor = createMonitor(hafas, bbox, 4 * 1000)

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
	a.ok(t.direction)
}

const onStopover = spy((s, t) => {
	a.ok(s.stop)
	a.ok('arrival' in s)
	a.ok('arrivalDelay' in s)
	a.ok('arrivalPlatform' in s)
	a.ok('departure' in s)
	a.ok('departureDelay' in s)
	a.ok('departurePlatform' in s)

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

let statsEvents = 0
const onStats = (s) => {
	a.ok('totalReqs' in s)
	a.ok('avgReqDuration' in s)
	a.ok('queuedReqs' in s)
	a.ok('trips' in s)

	if (++statsEvents >= 10) {
		a.ok(onStopover.called, 'stopover not emitted')
		a.ok(onTrip.called, 'trip not emitted')
		a.ok(onPosition.called, 'position not emitted')

		// teardown
		monitor.removeListener('stopover', onStopover)
		monitor.removeListener('trip', onTrip)
		monitor.removeListener('position', onPosition)
		monitor.removeListener('stats', onStats)
	}
}
monitor.on('stats', onStats)
