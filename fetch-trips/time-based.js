'use strict'

const {Gauge} = require('prom-client')
const createPromiseQueue = require('../lib/timed-promise-queue')

const createTimedTripFetchingStrategy = (shouldFetchTrip) => {
	const timedTripFetchingStrategy = (monitor) => {
		// metrics
		const queueSizeTotal = new Gauge({
			name: 'fetch_trips_queue_size_total',
			help: 'nr. of trip fetching tasks queued',
			registers: [monitor.metricsRegistry],
		})
		let reportQueueSizeInterval

		const onError = (err) => monitor.emit('error', err)
		const queue = createPromiseQueue(monitor.fetchTrip, onError, {
			// todo: customisable concurrency
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

module.exports = createTimedTripFetchingStrategy
