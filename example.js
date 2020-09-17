'use strict'

const createThrottledHafas = require('vbb-hafas/throttle')
const createMonitor = require('.')

const potsdamerPlatz = {
	north: 52.52,
	west: 13.36,
	south: 52.5,
	east: 13.39,
}
const bbox = process.env.BBOX
	? JSON.parse(process.env.BBOX)
	: potsdamerPlatz

const userAgent = 'hafas-monitor-trips example'
const hafas = createThrottledHafas(userAgent, 5, 1000) // 5 req/s

monitor.on('stopover', (stopover, trip) => {
	const dep = stopover.departure || stopover.plannedDeparture
	const arr = stopover.arrival || stopover.plannedArrival
	console.log(trip.id, trip.line.name, 'next', stopover.stop.name, dep || arr)
})
monitor.on('position', (location, movement) => {
	console.log(movement.tripId, movement.line.name, 'pos', location.latitude, location.longitude)
})
// monitor.on('trip', trip => console.log(trip.stopovers))
// monitor.on('new-trip', (tripId, t) => console.log('going to watch trip', tripId, t.line.name))
// monitor.on('trip-obsolete', (tripId, t) => console.log('not watching trip anymore', tripId, t.line.name))

monitor.on('error', console.error)
monitor.on('stats', console.error)
