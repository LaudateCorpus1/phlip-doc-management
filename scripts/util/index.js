const fs = require('fs')
const { logger } = require('./logger')

const stateToJurLookup = {
  AL: 'Alabama (state)',
  AK: 'Alaska (state)',
  AZ: 'Arizona (state)',
  AR: 'Arkansas (state)',
  CA: 'California (state)',
  CO: 'Colorado (state)',
  CT: 'Connecticut (state)',
  DE: 'Delaware (state)',
  FL: 'Florida (state)',
  GA: 'Georgia (state)',
  HI: 'Hawaii (state)',
  ID: 'Idaho (state)',
  IL: 'Illinois (state)',
  IN: 'Indiana (state)',
  IA: 'Iowa (state)',
  KS: 'Kansas (state)',
  KY: 'Kentucky (state)',
  LA: 'Louisiana (state)',
  ME: 'Maine (state)',
  MD: 'Maryland (state)',
  MA: 'Maine (state)',
  MI: 'Michigan (state)',
  MN: 'Minnesota (state)',
  MS: 'Mississippi (state)',
  MO: 'Missouri (state)',
  MT: 'Montana (state)',
  NE: 'Nebraska (state)',
  NV: 'Nevada (state)',
  NH: 'New Hampshire (state)',
  NJ: 'New Jersey (state)',
  NM: 'New Mexico (state)',
  NY: 'New York (state)',
  NC: 'North Carolina (state)',
  ND: 'North Dakota (state)',
  OH: 'Ohio (state)',
  OK: 'Oklahoma (state)',
  OR: 'Oregon (state)',
  PA: 'Pennsylvania (state)',
  RI: 'Rhode Island (state)',
  SC: 'South Carolina (state)',
  SD: 'South Dakota (state)',
  TN: 'Tennessee (state)',
  TX: 'Texas (state)',
  UT: 'Utah (state)',
  VT: 'Vermont (state)',
  VA: 'Virginia (state)',
  WA: 'Washington (state)',
  WV: 'West Virginia (state)',
  WI: 'Wisconsin (state)',
  WY: 'Wyoming (state)'
}

/**
 * Removes the extension from the file name
 * @param string
 * @returns {{extension: *, name: *}}
 */
const removeExtension = string => {
  const pieces = [...string.split('.')]
  let name = string, extension = ''
  if (pieces.length > 0) {
    extension = pieces[pieces.length - 1]
    pieces.pop()
    name = pieces.join('.')
  }
  
  return { name, extension }
}

/**
 * Remove temporary files that were creating during conversion
 * @param filesToRemove
 * @returns {Promise<void>}
 */
const removeTmpFiles = async filesToRemove => {
  await Promise.all(filesToRemove.map(async file => {
    return new Promise((resolve, reject) => {
      fs.unlink(file, err => {
        if (err) logger.error(err)
        resolve()
      })
    })
  }))
}

module.exports = {
  stateToJurLookup,
  removeExtension,
  removeTmpFiles
}
