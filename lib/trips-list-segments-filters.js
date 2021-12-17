'use strict'

const uniq = require('lodash/uniq')

// For a set of previously used tripsByName() filters, compute >1 new sets
// of filters for tripsByName() calls that shall return less results each.
// Conceptually, this is like computing children of a node in a search tree.
const tripsListSegmentsFilters = (hafas, prevLineNameOrFahrtNr, prevOpts, prevTrips) => {
	const noProducts = {}
	for (const p of hafas.profile.products) noProducts[p.id] = false

	// go with segmenting by product first, 1 product each
	if (!('products' in prevOpts)) {
		return hafas.profile.products.map((product) => ({
			lineNameOrFahrtNr: prevLineNameOrFahrtNr,
			opts: {
				...prevOpts,
				products: {
					...noProducts,
					[product.id]: true,
				},
			},
		}))
	}

	// otherwise segment by operator
	if (!('operatorNames' in prevOpts)) {
		// `prevTrips` may exclude operators because it is clipped at
		// `TRIPS_BY_NAME_MAX_RESULTS`, so we need to need to add a "catch-all"
		// segment as well.
		const operators = uniq(
			prevTrips
			.map(t => t.line && t.line.operator && t.line.operator.name)
			.filter(operator => !!operator)
		)
		return [
			...operators.map((operator) => ({
				lineNameOrFahrtNr: prevLineNameOrFahrtNr,
				opts: {
					...prevOpts,
					operatorNames: [operator],
				},
			})),
			// todo: catch-all segment, but there's not "negative" operator filter
		]
	}

	if (prevLineNameOrFahrtNr === '*') {
		// `prevTrips` may exclude some lines's trips because it is clipped at
		// `TRIPS_BY_NAME_MAX_RESULTS`, so we need to need to add a "catch-all"
		// segment as well.
		const lineNames = uniq(
			prevTrips
			.map(t => t.line && t.line.name)
			.filter(lineName => !!lineName)
		)
		return [
			...lineNames.map((lineName) => ({
				lineNameOrFahrtNr: lineName,
				opts: prevOpts,
			})),
			// todo: catch-all segment, but AFAIK there's no "negative" operator filter
		]
	}

	// todo: how do we segment here?
	throw new Error('4th level of segmenting is not supported')
}

module.exports = tripsListSegmentsFilters
