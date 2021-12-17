'use strict'

// const createThrottledHafas = require('vbb-hafas/throttle')
const {default: PQueue} = require('p-queue')
const {request} = require('hafas-client/lib/default-profile')
const createHafas = require('hafas-client')
const vbbProfile = require('hafas-client/p/vbb')
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

const queue = new PQueue({concurrency: 1})
const throttledRequest = (...args) => queue.add(() => request(...args))

const userAgent = 'hafas-monitor-trips example'
// const hafas = createThrottledHafas(userAgent, 5, 1000) // 5 req/s
const hafas = createHafas({
	...vbbProfile,
	request: throttledRequest,
}, userAgent)

const monitor = createMonitor(hafas, bbox, {
	fetchTripsInterval: 60_000, // 60s
})
monitor.once('error', (err) => {
	console.error(err)
	process.exit(1)
})
monitor.on('hafas-error', console.error)

monitor.on('stopover', (st) => {
	process.stdout.write(JSON.stringify(st) + '\n')
})
// monitor.on('trip', (trip) => {
// 	console.log(trip.stopovers)
// })
// monitor.on('position', (loc, movement) => {
// 	console.log(movement.tripId, movement.line.name, 'pos', loc.latitude, loc.longitude)
// })
