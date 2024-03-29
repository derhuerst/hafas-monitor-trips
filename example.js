/* eslint-disable no-unused-vars */

import {
	createThrottledClient as createThrottledHafas,
} from 'vbb-hafas/throttle.js'
import {createMonitor} from './index.js'
import {
	addTripsFetchingToMonitor as fetchTrips,
} from './fetch-trips/index.js'
import {
	createPriorityBasedTripFetchingStrategy as prioBasedTripFetching,
} from './fetch-trips/priority-based.js'
import {
	createTimeBasedTripFetchingStrategy as timeBasedTripFetching,
} from './fetch-trips/time-based.js'

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
monitor.on('hafas-error', console.error)

const prioStrategy = prioBasedTripFetching((movement) => {
	if (movement.line.product === 'subway') return 0
	return null
})
const timeBasedStrategy = timeBasedTripFetching((movement) => {
	if (movement.line.product === 'subway') return 1
	return null
})
fetchTrips(monitor, {
	// strategy: prioStrategy,
	strategy: timeBasedStrategy,
})

monitor.on('trip', (trip) => {
	console.log('trip', trip.id, trip.line.name)
})
monitor.on('position', (loc, movement) => {
	console.log('movement', movement.tripId, movement.line.name, 'pos', loc.latitude, loc.longitude)
})
