import {createRequire} from 'node:module'
const require = createRequire(import.meta.url)

import {Gauge} from 'prom-client'
import PromiseQueue from 'p-queue'
import {redisReadRange} from '../lib/redis-read-range.js'
const pkg = require('../package.json')

const REDIS_TRIPS_QUEUE_NS = pkg.version.split('.')[0] + ':trips-prioritised-q:'

const createPriorityBasedTripFetchingStrategy = (shouldFetchTrip, opt = {}) => {
	const {
		concurrency,
	} = {
		concurrency: 8,
		...opt,
	}

	const priorityBasedTripFetchingStrategy = (monitor) => {
		const {redis} = monitor
		if (!redis) throw new Error('missing monitor.redis.')

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

		const onError = (err) => monitor.emit('error', err)
		const addTripFetchingTask = (taskId, priority, tripId, lineName, persist = true) => {
			const fetchTrip = async () => {
				await monitor.fetchTrip(tripId, lineName)
				redis.del(taskId).catch(onError)
			}
			queue.add(fetchTrip, {priority})

			if (persist) {
				redis.set(taskId, JSON.stringify([priority, tripId, lineName])) // todo: expire?
				.catch(onError)
			}
		}

		monitor.on('position', (_, movement) => {
			const priority = shouldFetchTrip(movement) // todo: async fn?
			if (priority === null) return;

			const taskId = REDIS_TRIPS_QUEUE_NS + Math.random().toString(16).slice(2, 6)
			const tripId = movement.tripId
			const lineName = movement.line && movement.line.name || '?'
			addTripFetchingTask(taskId, priority, tripId, lineName)
		})

		const readPersistedTasks = async () => {
			for await (const [key, _] of redisReadRange(redis, REDIS_TRIPS_QUEUE_NS)) {
				const taskId = key.slice(REDIS_TRIPS_QUEUE_NS.length)
				const [priority, tripId, lineName] = JSON.parse(_)
				addTripFetchingTask(taskId, priority, tripId, lineName, false)
			}
		}

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

		readPersistedTasks().catch(onError)
	}
	return priorityBasedTripFetchingStrategy
}

export {
	createPriorityBasedTripFetchingStrategy,
}
