import express from 'express'
import program from 'commander'
import ngrok from 'ngrok'
import parse from 'url-parse'
import { AgentRouter } from 'daf-express'
import { getOpenApiSchema } from 'daf-rest'
import swaggerUi from 'swagger-ui-express'
import { getAgent, getConfig } from './setup'
import { createObjects } from './lib/objectCreator'

program
  .command('server')
  .description('Launch OpenAPI server')
  .option('-p, --port <number>', 'Optionally set port to override config')
  .action(async (cmd) => {
    const app = express()
    const agent = getAgent(program.config)
    const { server: options } = createObjects(getConfig(program.config), { server: '/server' })

    const exposedMethods = options.exposedMethods ? options.exposedMethods : agent.availableMethods()

    const apiBasePath = options.apiBasePath

    const agentRouter = AgentRouter({
      basePath: apiBasePath,
      getAgentForRequest: async (req) => agent,
      exposedMethods,
      serveSchema: true,
    })

    app.use(apiBasePath, agentRouter)

    app.listen(cmd.port || options.port, async () => {
      console.log(`🚀 Agent server ready at http://localhost:${cmd.port || options.port}`)
      console.log('🧩 Available methods', agent.availableMethods().length)
      console.log('🛠  Exposed methods', exposedMethods.length)

      let baseUrl = options.baseUrl

      if (options.ngrok?.connect) {
        baseUrl = await ngrok.connect({
          addr: cmd.port || options.port,
          subdomain: options.ngrok.subdomain,
          region: options.ngrok.region,
          authtoken: options.ngrok.authtoken,
        })
      }
      const hostname = parse(baseUrl).hostname

      const openApiSchema = getOpenApiSchema(agent, apiBasePath, exposedMethods)
      openApiSchema.servers = [{ url: baseUrl }]

      app.use(options.apiDocsPath, swaggerUi.serve, swaggerUi.setup(openApiSchema))
      console.log('📖 API Documentation', baseUrl + options.apiDocsPath)

      app.get(options.schemaPath, (req, res) => {
        res.json(openApiSchema)
      })

      console.log('🗺  OpenAPI schema', baseUrl + options.schemaPath)

      if (options.defaultIdentity.create) {
        let serverIdentity = await agent.identityManagerGetOrCreateIdentity({
          provider: 'did:web',
          alias: hostname,
        })
        console.log('🆔', serverIdentity.did)

        const messagingServiceEndpoint = baseUrl + options.defaultIdentity.messagingServiceEndpoint

        await agent.identityManagerAddService({
          did: serverIdentity.did,
          service: {
            id: serverIdentity.did + '#msg',
            type: 'Messaging',
            description: 'Handles incoming POST messages',
            serviceEndpoint: messagingServiceEndpoint,
          },
        })
        console.log('📨 Messaging endpoint', messagingServiceEndpoint)

        app.post(
          options.defaultIdentity.messagingServiceEndpoint,
          express.text({ type: '*/*' }),
          async (req, res) => {
            try {
              const message = await agent.handleMessage({ raw: req.body, save: true })
              console.log('Received message', message.type, message.id)
              res.json({ id: message.id })
            } catch (e) {
              console.log(e)
              res.send(e.message)
            }
          },
        )

        const didDocEndpoint = '/.well-known/did.json'
        app.get(didDocEndpoint, async (req, res) => {
          serverIdentity = await agent.identityManagerGetOrCreateIdentity({
            provider: 'did:web',
            alias: hostname,
          })

          const didDoc = {
            '@context': 'https://w3id.org/did/v1',
            id: serverIdentity.did,
            publicKey: serverIdentity.keys.map((key) => ({
              id: serverIdentity.did + '#' + key.kid,
              type: key.type === 'Secp256k1' ? 'Secp256k1VerificationKey2018' : 'Ed25519VerificationKey2018',
              controller: serverIdentity.did,
              publicKeyHex: key.publicKeyHex,
            })),
            authentication: serverIdentity.keys.map((key) => ({
              type:
                key.type === 'Secp256k1'
                  ? 'Secp256k1SignatureAuthentication2018'
                  : 'Ed25519SignatureAuthentication2018',
              publicKey: serverIdentity.did + '#' + key.kid,
            })),
            service: serverIdentity.services,
          }

          res.json(didDoc)
        })
        console.log('📋 DID Document ' + baseUrl + didDocEndpoint)

        app.get('/', (req, res) => {
          const links = [
            { label: 'API Docs', url: options.apiDocsPath },
            { label: 'API Schema', url: options.apiBasePath },
          ]

          const html = `<html><head><title>DID Agent</title></head><body>${links
            .map((l) => `<a href="${l.url}">${l.label}</a>`)
            .join('<br/>')}</body></html>`
          res.send(html)
        })
      }
    })
  })
