'use strict'

const {polygon, point} = require('@turf/helpers')
const isWithin = require('@turf/boolean-within').default

const SECOND = 1000
const MINUTE = 60 * SECOND

const createIsStopoverObsolete = (bbox) => {
	const bboxAsRectangle = polygon([[
		[bbox.west, bbox.north],
		[bbox.east, bbox.north],
		[bbox.east, bbox.south],
		[bbox.west, bbox.south],
		[bbox.west, bbox.north] // close
	]])

	const isStopoverObsolete = (s) => {
		const when = s.arrival || s.departure || s.plannedArrival || s.plannedDeparture
		// todo: this might stop observing trips without realtime data
		const inThePast = when && Date.parse(when) < (Date.now() - 10 * MINUTE)
		if (inThePast) return true

		const stopLoc = point([s.stop.location.longitude, s.stop.location.latitude])
		return !isWithin(stopLoc, bboxAsRectangle)
	}

	return isStopoverObsolete
}

module.exports = createIsStopoverObsolete
