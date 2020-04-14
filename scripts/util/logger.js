const winston = require('winston')
const path = require('path')

winston.addColors({
  error: 'red',
  warn: 'yellow',
  info: 'cyan',
  debug: 'green'
})

/**
 * Formatter for log
 */
const getLogFormatter = () => {
  const { combine, timestamp, printf } = winston.format
  
  return combine(
    timestamp(),
    printf(info => {
      const { req, res } = info.message
      const date = new Date(info.timestamp).toLocaleString('en-us', { timeZone: 'America/New_York' })
      const pre = `[${date}]:`
      
      const message = req
        ? `${req.ip} - ${req.method} ${req.url} - ${res.statusCode} - ${res.statusMessage}`
        : info.message

      if (process.env.NODE_ENV !== 'test') {
        console.log(message)
      }
      return `${pre} ${message}`
    })
  )
}

/**
 * Combined logger
 * @type {winston.Logger}
 */
const logger = winston.createLogger({
  level: winston.config.syslog.levels,
  format: getLogFormatter(),
  transports: [
    new winston.transports.File({ filename: path.resolve('logs/error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.resolve('logs/out.log'), level: 'info' })
  ]
})

module.exports = {
  logger
}
