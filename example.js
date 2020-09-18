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

const monitor = createMonitor(hafas, bbox, {
	fetchTripsInterval: 10_000, // 10s
})
monitor.once('error', (err) => {
	console.error(err)
	process.exit(1)
})
monitor.on('stats', console.error)

monitor.on('stopover', (st) => {
	process.stdout.write(JSON.stringify(st) + '\n')
})
// monitor.on('trip', (trip) => {
// 	console.log(trip.stopovers)
// })
// monitor.on('position', (loc, movement) => {
// 	console.log(movement.tripId, movement.line.name, 'pos', loc.latitude, loc.longitude)
// })
