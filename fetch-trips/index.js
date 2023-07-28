import createDebug from 'debug'
import {noCache} from '../lib/no-cache.js'
import {
	createRightAwayTripFetchingStrategy as rightAwayStrategy,
} from './right-away.js'

const debug = createDebug('hafas-monitor-trips:trips')

const addTripsFetchingToMonitor = (monitor, opt = {}) => {
	const {
		hafas,
		metricsRegistry,
		bbox,
		onReqTime,
		handleFetchError,
	} = monitor
	if (!hafas || 'function' !== typeof hafas.trip) {
		throw new TypeError('monitor.hafas.trip must be a function.')
	}
	if (!metricsRegistry) throw new Error('missing monitor.metricsRegistry.')
	if (!bbox) throw new Error('missing monitor.bbox.')
	if ('function' !== typeof onReqTime) {
		throw new TypeError('monitor.onReqTime must be a function.')
	}
	if ('function' !== typeof handleFetchError) {
		throw new TypeError('monitor.handleFetchError must be a function.')
	}

	const {
		strategy,
		hafasTripOpts,
	} = {
		strategy: rightAwayStrategy(() => true),
		hafasTripOpts: {},
		...opt,
	}
	if ('function' !== typeof strategy) {
		throw new TypeError('opt.strategy must be a function.')
	}

	const fetchTrip = async (id, lineName) => {
		debug('fetching trip', id, lineName)

		const t0 = Date.now()
		let trip
		try {
			// todo: remove trip if not found
			trip = await hafas.trip(id, lineName, {
				stopovers: true,
				polyline: false,
				entrances: false,
				// todo: `opt.language`
				...hafasTripOpts,
				...noCache,
			})
		} catch (err) {
			// emits HAFAS-specific errors, throws all others
			handleFetchError('trip', err)
			return; // todo: retry?
		}
		onReqTime('trip', Date.now() - t0)

		monitor.emit('trip', trip)
		for (const stopover of trip.stopovers) {
			// todo: only emit if there's a listener?
			monitor.emit('stopover', {
				tripId: trip.id,
				line: trip.line,
				...stopover
			}, trip)
		}
	}
	monitor.fetchTrip = fetchTrip

	strategy(monitor)
}

export {
	addTripsFetchingToMonitor,
}
