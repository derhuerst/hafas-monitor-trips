const createRightAwayTripFetchingStrategy = (shouldFetchTrip) => {
	const rightAwayTripFetchingStrategy = (monitor) => {
		const onError = (err) => monitor.emit('error', err)

		monitor.on('position', (_, movement) => {
			if (!shouldFetchTrip(movement)) return; // todo: async fn?

			const tripId = movement.tripId
			const lineName = movement.line && movement.line.name || '?'

			monitor.fetchTrip(tripId, lineName)
			.catch(onError)
		})
	}
	return rightAwayTripFetchingStrategy
}

export {
	createRightAwayTripFetchingStrategy,
}
