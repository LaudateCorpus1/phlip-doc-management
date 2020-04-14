const swaggerDocument = require('./swagger.json')
const express = require('express')

module.exports = app => {
  // Serve API swagger docs only when not running in production
  const options = {
    customCssUrl: '/swagger.css'
  }

  if (process.env.NODE_ENV !== 'production') {
    const swagger = require('swagger-ui-express')
    
    app.use('/api-docs', swagger.serve, swagger.setup(swaggerDocument, options))
    app.use('/swagger.css', express.static(__dirname + '/swagger.css'));
  }
}