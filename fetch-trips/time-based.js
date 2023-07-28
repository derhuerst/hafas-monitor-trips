import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)

import {Gauge} from 'prom-client'
import {
	createTimedPromiseQueue as createPromiseQueue,
} from '../lib/timed-promise-queue.js'
const pkg = require('../package.json')

const REDIS_TRIPS_QUEUE_NS = pkg.version.split('.')[0] + ':trips-timed-q:'

const createTimedTripFetchingStrategy = (shouldFetchTrip) => {
	const timedTripFetchingStrategy = (monitor) => {
		const {redis} = monitor
		if (!redis) throw new Error('missing monitor.redis.')

		// metrics
		const queueSizeTotal = new Gauge({
			name: 'fetch_trips_queue_size_total',
			help: 'nr. of trip fetching tasks queued',
			registers: [monitor.metricsRegistry],
		})
		let reportQueueSizeInterval

		// todo: allow passing a payload into `queue`
		const fetchTrip = (tripId) => monitor.fetchTrip(tripId, '?') // todo: fix properly
		const onError = (err) => monitor.emit('error', err)
		const queue = createPromiseQueue(fetchTrip, onError, {
			// todo: customisable concurrency
			redis, redisNs: REDIS_TRIPS_QUEUE_NS,
		})
		const reportQueueSize = () => {
			queueSizeTotal.set(queue.size)
		}

		monitor.on('position', (_, movement) => {
			const when = shouldFetchTrip(movement) // todo: async fn?
			if (when === null) return;

			queue.put(movement.tripId, when)
		})

		const start = () => {
			queue.start()
			reportQueueSizeInterval = setInterval(reportQueueSize, 5 * 1000)
		}

		const stop = () => {
			queue.stop()
			clearInterval(reportQueueSizeInterval)
		}

		monitor.on('start', start)
		monitor.on('stop', stop)
		// todo: check if the monitor is currently running
		setImmediate(start)
	}
	return timedTripFetchingStrategy
}

export {
	createTimedTripFetchingStrategy as createTimeBasedTripFetchingStrategy,
}
