'use strict'

const {Gauge} = require('prom-client')
const PromiseQueue = require('p-queue').default

const createPriorityBasedTripFetchingStrategy = (shouldFetchTrip, opt = {}) => {
	const {
		concurrency,
	} = {
		concurrency: 8,
		...opt,
	}

	const priorityBasedTripFetchingStrategy = (monitor) => {
		// metrics
		const queueSizeTotal = new Gauge({
			name: 'fetch_trips_queue_size_total',
			help: 'nr. of trip fetching tasks queued',
			registers: [monitor.metricsRegistry],
		})
		let reportQueueSizeInterval

		// todo: persist queue in Redis
		const queue = new PromiseQueue({
			concurrency,
			autoStart: false,
			// todo: timeout & throwOnTimeout?
		})
		const reportQueueSize = () => {
			queueSizeTotal.set(queue.size)
		}

		monitor.on('position', (_, movement) => {
			const priority = shouldFetchTrip(movement) // todo: async fn?
			if (priority === null) return;

			const tripId = movement.tripId
			const lineName = movement.line && movement.line.name || '?'
			queue.add(() => monitor.fetchTrip(tripId, lineName), {priority})
		})

		const start = () => {
			queue.start()
			reportQueueSizeInterval = setInterval(reportQueueSize, 5 * 1000)
		}

		const stop = () => {
			queue.pause()
			clearInterval(reportQueueSizeInterval)
		}

		monitor.on('start', start)
		monitor.on('stop', stop)
		// todo: check if the monitor is currently running
		setImmediate(start)
	}
	return priorityBasedTripFetchingStrategy
}

module.exports = createPriorityBasedTripFetchingStrategy
