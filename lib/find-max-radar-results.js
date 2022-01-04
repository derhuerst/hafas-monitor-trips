'use strict'

const debug = require('debug')('hafas-monitor-trips:find-max-radar-results')
const distance = require('@turf/distance').default
const dest = require('@turf/destination').default
const {ok} = require('assert')
const pkg = require('../package.json')

const REDIS_NS = pkg.version.split('.')[0] + ':max-radar-res'

const MAX_ITERATIONS = 20
const ENOUGH_RESULTS = 10000
// We assume that the maximum nr. of results is statically configured in a HAFAS
// endpoint and therefore doesn't change often.
const CACHE_TTL = 7 * 24 * 60 * 60 // 1 week

const findMaxRadarResults = async (hafas, initialBbox, onReqTime, onMovement) => {
	// this is accurate enough for our use case
	const center = {
		type: 'Point',
		coordinates: [
			initialBbox.east - (initialBbox.east - initialBbox.west) / 2,
			initialBbox.north - (initialBbox.north - initialBbox.south) / 2,
		],
	}
	const w = distance(
		{type: 'Point', coordinates: [initialBbox.west, center.coordinates[1]]},
		{type: 'Point', coordinates: [initialBbox.east, center.coordinates[1]]},
	)
	const h = distance(
		{type: 'Point', coordinates: [center.coordinates[0], initialBbox.north]},
		{type: 'Point', coordinates: [center.coordinates[0], initialBbox.south]},
	)
	debug('initial bbox', initialBbox)
	debug('center', center.coordinates, 'width', w, 'height', h)

	let prevResults = -Infinity
	for (let it = 0, distFactor = .1; it < MAX_ITERATIONS, distFactor < 10; it++, distFactor *= 2) {
		const _north = dest(center, distFactor * h / 2,   0).geometry.coordinates[1]
		const _west = dest(center, distFactor * w / 2,  270).geometry.coordinates[0]
		const _south = dest(center, distFactor * h / 2, 180).geometry.coordinates[1]
		const _east = dest(center, distFactor * w / 2,   90).geometry.coordinates[0]
		const bbox = {
			north: Math.round(_north * 10000) / 10000,
			west: Math.round(_west * 10000) / 10000,
			south: Math.round(_south * 10000) / 10000,
			east: Math.round(_east * 10000) / 10000,
		}

		debug('calling radar()', 'iteration', it, 'bbox', bbox)
		const t0 = Date.now()
		const movements = await hafas.radar(bbox, {
			results: ENOUGH_RESULTS,
		})
		onReqTime('radar', Date.now() - t0)

		for (const m of movements) onMovement(m)

		const results = movements.length
		if (results !== 0 && results === prevResults) {
			// todo: what if we hit the nr of vehicles currently running in the whole network?
			debug(results, 'results, same as before, assuming this is the limit')
			return results
		}
		debug(results, 'results')
		prevResults = results
	}

	debug('max nr. of iterations, assuming', prevResults, 'is the limit')
	return prevResults
}

const cachedFindMaxRadarResults = async (hafas, bbox, redis, onReqTime, onMovement) => {
	ok(hafas.profile.endpoint, 'hafas.profile.endpoint must not be empty')
	const cacheKey = REDIS_NS + ':' + hafas.profile.endpoint

	const fromCache = await redis.get(cacheKey)
	if (fromCache) {
		const maxResults = parseInt(fromCache)
		debug('using maxResults from Redis cache', maxResults)
		return maxResults
	}

	const maxResults = await findMaxRadarResults(hafas, bbox, onReqTime, onMovement)

	await redis.setex(cacheKey, CACHE_TTL, maxResults + '')
	return maxResults
}

module.exports = cachedFindMaxRadarResults
