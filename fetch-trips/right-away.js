'use strict'

const createRightAwayTripFetchingStrategy = (shouldFetchTrip) => {
	const rightAwayTripFetchingStrategy = (monitor) => {
		const {
			handleFetchError,
		} = monitor
		if ('function' !== typeof handleFetchError) {
			throw new TypeError('monitor.handleFetchError must be a function.')
		}

		const onError = (err) => monitor.emit('error', err)

		monitor.on('position', (_, movement) => {
			if (!shouldFetchTrip(movement)) return; // todo: async fn?

			const tripId = movement.tripId
			const lineName = movement.line && movement.line.name || '?'

			monitor.fetchTrip(tripId, lineName)
			.catch(handleFetchError)
			.catch(onError)
		})
	}
	return rightAwayTripFetchingStrategy
}

module.exports = createRightAwayTripFetchingStrategy
