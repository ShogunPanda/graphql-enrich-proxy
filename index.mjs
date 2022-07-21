'use strict'

import fastify from 'fastify'
import { formatError } from 'graphql/error/index.js'
import { parse, print, visit } from 'graphql/language/index.js'
import undici from 'undici'

const agent = new undici.Agent({ pipelining: 0 })

function injectedTypeField(id) {
  return { kind: 'Field', alias: { kind: 'Name', value: id }, name: { kind: 'Name', value: '__typename' } }
}

function graphql(url, query) {
  return undici.request(url, {
    method: 'POST',
    path: '/graphql',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query }),
    dispatcher: agent
  })
}

async function getStream(stream) {
  let data = Buffer.alloc(0)
  for await (const chunk of stream) {
    data = Buffer.concat([data, chunk])
  }

  return data
}

async function traverse(current, path, visitor) {
  // This is to handle the initial call
  if (typeof path === 'function') {
    visitor = path
    path = ['$']
  }

  // First of all, call the visitor on the current object
  await visitor(current, path)

  /*
    For each enumerable property in the object,
    perform a depth first traverse of the property if it is an array of objects or an object
  */
  for (const [property, value] of Object.entries(current)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        await traverse(value[i], path.concat(property, i), visitor)
      }
      // Say thanks to JS typing for the null checking
    } else if (typeof value === 'object' && value !== null) {
      await traverse(value, path.concat(property), visitor)
    }
  }
}

function addTypesInformation(document) {
  const injectedFieldId = `enrichType_${Date.now()}`
  const injectedField = injectedTypeField(`enrichType_${Date.now()}`)

  const updatedDocument = visit(document, {
    SelectionSet(node) {
      // Check if the __typename is already included and without aliases
      for (const field of node.selections) {
        if (field.name.value === '__typename' && !field.alias) {
          return
        }
      }

      // If we got there, it means we still have to add the typename
      node.selections.unshift(injectedField)
      return node
    }
  })

  return [updatedDocument, injectedFieldId]
}

async function addWeatherInformation(type, path, value) {
  if (type !== 'City') {
    return
  }

  // Get weather information for today for the city
  const response = await undici.request('https://goweather.herokuapp.com', {
    method: 'GET',
    path: `/weather/${value.name}`,
    dispatcher: agent
  })

  const body = JSON.parse(await getStream(response.body))

  return response.statusCode === 200
    ? { temperature: body.temperature }
    : {
        error: {
          statusCode: response.statusCode,
          body
        }
      }
}

async function enrich(data, enrichedId, handler) {
  const extensions = {}

  await traverse(data, async function (value, path) {
    // Execute the handler on the node and eventually add the returned data
    const additional = await handler(value.__typename || value[enrichedId], path, value)

    if (additional) {
      extensions[path.join('.').replace(/\.(\d+)\./g, '[$1].')] = additional
    }

    // Make sure we remove any fields we added
    value[enrichedId] = undefined
  })

  return extensions
}

const server = fastify()

server.post('/graphql', async function handleQuery(req, reply) {
  let document

  // Parse the query and check for syntax error
  try {
    document = parse(req.body.query)
  } catch (e) {
    return { errors: formatError(e) }
  }

  console.log(`\x1b[33m--- ORIGINAL QUERY ---\x1b[0m\n${print(document)}\n`)

  // Add types information to the query
  const [enrichedAst, enrichedId] = addTypesInformation(document)
  const enrichedDocument = print(enrichedAst)

  console.log(`\x1b[33m--- ENRICHED QUERY ---\x1b[0m\n${enrichedDocument}\n`)

  // Execute the query on the upstream
  const response = await graphql('https://api.geographql.rudio.dev', enrichedDocument)

  if (response.statusCode !== 200) {
    reply.code(response.statusCode)
    return response.body
  }

  const graphqlResponse = JSON.parse(await getStream(response.body))
  console.log(`\x1b[33m--- ORIGINAL RESPONSE ---\x1b[0m\n${JSON.stringify(graphqlResponse, null, 2)}\n`)

  // Execute the enriching handler to fetch additional data
  const extensions = await enrich(graphqlResponse.data, enrichedId, addWeatherInformation)

  // Return to the client
  return {
    ...graphqlResponse,
    extensions: { ...graphqlResponse.extensions, ...extensions }
  }
})

await server.listen({ port: 0 })

const response = await graphql(
  `http://localhost:${server.server.address().port}`,
  `
    {
      country(iso2: "US") {
        aliasedType: __typename
        name
        iso: iso2
        cities(page: { first: 3 }) {
          __typename
          edges {
            node {
              name
            }
          }
        }
      }
    }
  `
)

let body = await getStream(response.body)

if (body.length) {
  console.log(`\x1b[33m--- ENRICHED RESPONSE ---\x1b[0m`)

  try {
    body = JSON.stringify(JSON.parse(body.toString('utf-8')), null, 2)
  } catch {}

  console.log(body.toString('utf-8'))
}

await server.close()
