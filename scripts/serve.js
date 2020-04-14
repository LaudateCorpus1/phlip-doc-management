const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const mongoose = require('mongoose')
const dotenv = require('dotenv')
const path = require('path')
const fs = require('fs')
const constants = require('constants')
const https = require('https')
const http = require('http')
const jwt = require('express-jwt')
const { logger } = require('./util/logger')

const appDirectory = fs.realpathSync(process.cwd())
const appDotEnvPath = path.resolve(appDirectory, '.env')
const NODE_ENV = process.env.NODE_ENV || 'development'

const options = {
  keepAlive: 1,
  connectTimeoutMS: 30000,
  useNewUrlParser: true
}

mongoose.set('useFindAndModify', false)
dotenv.config({ path: appDotEnvPath })

const APP_HOST = process.env.APP_HOST || '0.0.0.0'
const APP_PORT = NODE_ENV === 'test' ? 3001 : process.env.APP_PORT || 3000
const FRONTEND_HOST = process.env.FRONTEND_HOST || 'http://localhost:5200'
const HTTPS_APP_PORT = process.env.HTTPS_APP_PORT || 443
const MONGO_HOST = NODE_ENV === 'test'
  ? '127.0.0.1'
  : process.env.MONGO_HOST || 'mongo'
const MONGO_PORT = process.env.MONGO_PORT || 27017
const DB_NAME = NODE_ENV === 'test'
  ? 'doc-test'
  : process.env.DB_NAME || 'doc-manage'
const SECRET = NODE_ENV === 'test'
  ? 'thisisnotsecure'
  : process.env.JWT_SECRET

/**
 * Creates the tmp dir to store files
 */
const TMP_FILE_DIR = path.resolve('tmp')
if (!fs.existsSync(TMP_FILE_DIR)) {
  fs.mkdirSync(TMP_FILE_DIR)
}

const logsDir = path.resolve('logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir)
}

/** Set up connection to mongodb. **/
mongoose.connect(`mongodb://${MONGO_HOST}:${MONGO_PORT}/${DB_NAME}`, options)
const db = mongoose.connection
db.on('error', console.error.bind(console, 'connection error: '))

/** Router used for doc-manage api **/
const router = require('./routes')
const app = express()

/* Only allow requests from the frontend */
app.use(cors({ origin: FRONTEND_HOST }))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
require('./swagger')(app)
app.use('/api', router)

app.use(jwt({
  secret: SECRET,
  getToken: req => {
    if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
      return req.headers.authorization.split(' ')[1]
    }
    return null
  }
}))

app.use((req, res) => {
  res.status(404).send()
  logger.error({ req, res })
})

if (NODE_ENV !== 'test' && process.env.IS_HTTPS === '1') {
  const httpsOptions = {
    key: fs.readFileSync(process.env.KEY_PATH),
    cert: fs.readFileSync(process.env.CERT_PATH),
    ca: fs.readFileSync(process.env.CERT_AUTH_PATH),
    requestCert: false,
    rejectUnauthorized: false,
    secureOptions: constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_TLSv1
  }

  // Start and HTTPS server
  https.createServer(httpsOptions, app).listen(HTTPS_APP_PORT, APP_HOST, err => {
    if (err) {
      logger.error(err)
    }
    console.log(`Starting the production server on ${APP_HOST}:${HTTPS_APP_PORT}...`)
    logger.info(`Starting the production server on ${APP_HOST}:${HTTPS_APP_PORT}...`)
  })

  // Start an HTTP server and redirect all requests to HTTPS
  http.createServer((req, res) => {
    res.writeHead(301, { 'Location': 'https://' + req.headers['host'] + req.url })
    res.end()
  }).listen(APP_PORT)

} else {
  http.createServer(app).listen(APP_PORT, APP_HOST, err => {
    if (err) {
      logger.error(err)
    }
  })
}

module.exports = app
