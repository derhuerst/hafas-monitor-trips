'use strict'

const createHafas = require('vbb-hafas')
const a = require('assert')
const createMonitor = require('.')

const bbox = {north: 52.52, west: 13.36, south: 52.5, east: 13.39}
const hafas = createHafas('hafas-monitor-trips example')
const monitor = createMonitor(hafas, bbox, 4 * 1000)

setTimeout(monitor.stop, 10 * 1000)
monitor.once('error', (err) => {
	console.error(err)
	process.exit(1)
})

const validateTrip = (t) => {
	a.ok(t.id)
	a.ok(t.line)
	a.ok(t.direction)
}

monitor.on('stopover', (s, t) => {
	a.ok(s.stop)
	a.ok('arrival' in s)
	a.ok('arrivalDelay' in s)
	a.ok('arrivalPlatform' in s)
	a.ok('departure' in s)
	a.ok('departureDelay' in s)
	a.ok('departurePlatform' in s)

	validateTrip(t)
})

monitor.on('trip', validateTrip)

monitor.on('position', (l, m) => {
	a.ok('latitude' in l)
	a.ok('longitude' in l)

	a.ok(m.tripId)
	a.ok(m.line)
	a.ok(m.direction)
})

monitor.on('stats', (s) => {
	a.ok('totalReqs' in s)
	a.ok('avgReqDuration' in s)
	a.ok('queuedReqs' in s)
	a.ok('trips' in s)
})
