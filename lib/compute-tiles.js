'use strict'

const distance = require('@turf/distance').default
const debug = require('debug')('hafas-monitor-trips')
const squareGrid = require('@turf/square-grid').default

const MAX_TILE_SIZE = 5 // in kilometers

const roundTo = (v, d) => +v.toFixed(d)

const computeTiles = (bbox) => {
	if ('number' !== typeof bbox.north) throw new TypeError('bbox.north must be a number.')
	if ('number' !== typeof bbox.west) throw new TypeError('bbox.west must be a number.')
	if ('number' !== typeof bbox.south) throw new TypeError('bbox.south must be a number.')
	if ('number' !== typeof bbox.east) throw new TypeError('bbox.east must be a number.')
	if (bbox.north <= bbox.south) throw new Error('bbox.north must be larger than bbox.south.')
	if (bbox.east <= bbox.west) throw new Error('bbox.east must be larger than bbox.west.')

	const tileSize = Math.min(
		distance([bbox.west, bbox.south], [bbox.east, bbox.south]), // southern edge
		distance([bbox.east, bbox.south], [bbox.east, bbox.north]), // eastern edge
		MAX_TILE_SIZE
	)
	debug('tile size', tileSize)

	const grid = squareGrid([bbox.west, bbox.south, bbox.east, bbox.north], tileSize)
	return grid.features.map((f) => {
		const coords = f.geometry.coordinates[0]
		return {
			north: roundTo(coords[2][1], 6),
			west: roundTo(coords[0][0], 6),
			south: roundTo(coords[0][1], 6),
			east: roundTo(coords[2][0], 6)
		}
	})
}

module.exports = computeTiles
