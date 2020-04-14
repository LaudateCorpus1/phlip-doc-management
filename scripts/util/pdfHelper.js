const fs = require('fs')
const { spawnSync, exec, spawn } = require('child_process')
const { logger } = require('./logger')
const util = require('./index')

class PDF {
  constructor(data, name) {
    this.data = Buffer.from(data)
    this.docString = this.data.toString('utf-8')
    this.name = name
    this.pages = []
    this.xrefStreams = null
    this.xrefTables = null
    this.cleanUpDocString()
    this.checkLinearization()
    this.checkXrefType()
  }

  /**
   * Begins the initialization of the file for parsing certain objects
   */
  async initialize() {
    logger.info(`${this.name}: initializing pdf for annotations`)
    try {
      if (this.linearized || this.xrefStreams) {
        logger.info(`${this.name}: is linearized or has xref object streams, converting now...`)
        await this.convert()
        await PDF.cleanUp()
      }
      await this.cleanUpDocString()
      await this.checkXrefType()
      await this.determineStartXref()
      await this.makeXrefTable()
      await this.determineCatalog()
      return this.determinePages()
    } catch (err) {
      throw err
    }
  }

  /**
   * Checks if the PDF is linearized
   */
  checkLinearization() {
    if (this.docString.match(/\/Linearized/gms)) {
      this.linearized = true
    }
  }

  /**
   * Check XRef types (whether the file uses tables or streams)
   */
  checkXrefType() {
    // check for xref .... trailer occurrences in file
    const xrefTableMatch = /[^start]xref(.*?)(?=trailer)/gs
    this.xrefTables = this.docString.match(xrefTableMatch)

    // check for /XRef dictionary entries
    const xrefStreamMatch = /\/XRef/gms
    this.xrefStreams = this.docString.match(xrefStreamMatch)
  }

  /**
   * Removes all data from the stream objects because it could be binary,
   * removes comments, and normalizes whitespaces
   */
  async cleanUpDocString() {
    const removeStreams = /stream(.*?)endstream/gs
    const removeComments = /%(.[^(PDF)][^%EOF]*?)\n/g
    const removeMultiSpace = /[^\S\n\r]{2,}/g
    const addNewLine = /(%%EOF)/gms

    return this.docString = this.docString
      .replace(addNewLine, '%%EOF\n')
      .replace(removeStreams, '\nstream\nendstream\n')
      .replace(removeMultiSpace, ' ')
      .replace(removeComments, '\n')
  }

  /**
   * Uses the qpdf tool to decompress the file, in the case that the file is linearized and / or there are xref object
   * streams instead of a table.
   */
  async convert() {
    return new Promise((resolve, reject) => {
      fs.writeFileSync('./temp.pdf', this.data)
      const decompressedPath = './decompressed.pdf'

      try {
        const convert = spawn('qpdf', ['--qdf', '--object-streams=disable', './temp.pdf', './decompressed.pdf'])

        convert.stdout.on('data', data => {
          logger.info(`${this.name}: convert stdout: ${data}`)
        })

        convert.stderr.on('data', error => {
          logger.info(`${this.name}: convert error: ${error}`)
          reject(error)
        })

        convert.on('close', code => {
          if (code === '0' || code === 0) {
            logger.info(`${this.name}: converted file successfully`)
            this.data = fs.readFileSync(decompressedPath)
            this.docString = this.data.toString('utf-8')
            resolve()
          } else {
            logger.error(`${this.name}: ERROR converting file... bailing...`)
            reject()
          }
        })
      } catch (err) {
        PDF.cleanUp()
        logger.error(err)
        reject(err)
      }
    })
  }

  /**
   * Actually goes through the files and makes the object table based on xrefs found
   */
  makeXrefTable() {
    logger.info(`${this.name}: generating xref table for document`)
    return new Promise(async (resolve, reject) => {
      try {
        const genMatch = /\b(\d+\s+\d+)(?!\s+([nf]))\b/g
        const offsetMatch = /\d+\s+\d+\s+[nf]/g
        let objTable = {}

        // Check if the PDF uses the cross-reference tables
        // The PDF uses xref tables. Loop through every xref table found
        for (let i = 0; i < this.xrefTables.length; i++) {
          const xref = this.xrefTables[i]

          // Match offset entries in the xref table
          const objs = xref.match(offsetMatch)
          if (objs) {
            const gens = xref.match(genMatch)
            let objIndex = 0
            // Loops through all of the new additions
            for (let gen of gens) {
              const nums = gen.match(/\d+/g)
              const objNum = nums[0]
              const genNum = nums[1]

              let j = parseInt(objNum)
              const total = j + parseInt(genNum)
              while (j < total) {
                const obj = objs[objIndex]
                const offsets = obj.match(/\d+/g)
                const gen = offsets[1].trim()
                objTable[j] = {
                  gen: gen === '00000'
                    ? 0
                    : gen.replace(/^0+/gms, ''), // remove leading zeroes from gen number
                  occurrence: objTable.hasOwnProperty(j)
                    ? j === 0
                      ? 0
                      : objTable[j].occurrence + 1
                    : 0,
                  offset: offsets[0].trim(),
                  xref: i
                }
                j += 1
                objIndex += 1
              }
            }
          }
        }

        this.objTable = objTable
        this.nextObjNum = Object.keys(this.objTable).map(a => parseInt(a)).sort((b, c) => b - c).pop() + 1
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Finds the catalog object so that the pages object can be found /Root specifies the /Catalog object number
   */
  async determineCatalog() {
    const rootMatch = /\/Root\s*\d+\s*0\s*R/gm
    const root = this.docString.match(rootMatch)[0]
    const catalogObjNum = root.match(/\d+(?!\s+R)/gm)[0]
    this.catalogObj = this.getObjectAt(catalogObjNum)
    await this.determineTrailer()
  }

  /**
   * Gets trailer information so it can be used when making updates
   */
  async determineTrailer() {
    const trailerMatch = /trailer(.*?)>>/gs
    const matches = this.docString.match(trailerMatch)
    this.lastTrailer = matches[matches.length - 1].match(/<<(.*?)>>/gs)[0].replace(/<<|>>/gs, '')
  }

  /**
   * Gets the last startxref number so can be used in the trailer of an updated
   */
  async determineStartXref() {
    const startxrefMatch = /startxref(.*?)\d+/gs
    const matches = this.docString.match(startxrefMatch)
    this.lastStartXref = matches[matches.length - 1].match(/\d+/gs)[0]
  }

  /**
   * Process kids until we are left with just page objects
   */
  async processKids(objNum, pages = []) {
    return new Promise(async resolve => {
      const kidsMatch = /\/Kids\s*\[\s*\n*(.*)\s*\n*\]/gs // match /Kids[]
      const kidObjMatch = /(\d+\s+(?=0\s+R))/gs // match object reference numbers in the Kids array
      const obj = this.getObjectAt(objNum) // get the object
      const pageKids = obj.match(kidsMatch)
      const kids = pageKids ? pageKids[0].match(kidObjMatch) : null // match kids object numbers
      if (kids) {
        // this is a parent page object. go through all of the kids and process those.
        let i = 0
        for (const kid of kids) {
          const num = kid.trim()
          pages = await this.processKids(num, pages)
          i += 1
          if (i === kids.length) {
            // we've processed all of the kids for this page
            resolve(pages)
          }
        }
      } else {
        // this is an actual page object. we can save the page
        pages.push({ obj, objNum })
        resolve(pages)
      }
    })
  }

  /**
   * Gets the pages object and stores them in order. Pages are not necessarily ordered with the closest to the
   * beginning
   * page having the smalled object number. /Kids [] lists the page object references in order. Stores pages
   * information, object number and associated annotation information, if any.
   */
  async determinePages() {
    return new Promise(async (resolve, reject) => {
      try {
        const pageRegex = /(?:\/Pages\s*)(\d+)/g // match /Type /Pages
        const pageKey = this.catalogObj.match(pageRegex)[0] // get the object reference of the /Pages object from catalog
        const pagesObjNum = pageKey.match(/\d+/g)[0] // extract just the number of the /Pages object

        const pages = await this.processKids(pagesObjNum)
        let i = 0
        for (const pagesObj of pages) {
          const pageObj = PDF.removeEmptyNewlines(PDF.cleanUpDictionary(pagesObj.obj))

          const page = {
            objNum: pagesObj.objNum,
            gen: this.objTable[pagesObj.objNum].gen,
            obj: pageObj,
            annots: null
          }

          const hasAnnots = pageObj.match(/\/Annots/g)

          if (hasAnnots) {
            page.annots = {
              objNum: null,
              isArray: false,
              isObj: false,
              gen: 0,
              objs: []
            }
            const isArr = pageObj.match(/\/Annots\s*\[/g)
            if (isArr) {
              page.annots.isArray = true
              page.annots.objs = pageObj.match(/\/Annots\s*\[(.*)\]/gs)[0].match(/(\d+\s+0\s+R)/g)
            } else {
              page.annots.isObj = true
              page.annots.objNum = pageObj.match(/\/Annots\s+(\d+\s+0\s+R)/g)[0].match(/\d+(?!\s+R)/g)[0]
              page.annots.gen = this.objTable[page.annots.objNum].gen
              page.annots.objs = this.getObjectAt(page.annots.objNum).match(/(\d+\s+0\s+R)/g)
            }
          }

          this.pages.push(page)
          i += 1
          if (i === pages.length) {
            resolve()
          }
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * When an update is made, update the trailer property in case there are additional updates
   * @param size
   */
  updateTrailer(size) {
    const temp = this.lastTrailer.replace(/(\/Size\s*|\/Prev\s*)(\d+)(\n*\s*)/gs, '')

    this.lastTrailer = `/Size ${size}
/Prev ${this.lastStartXref}
${temp}`
  }

  /**
   * Determines whether the update needs to happen to the page object (the page doesn't have any annotations or the
   * /Annots object is just an array. Or if the /Annots is an indirect object and that is what needs to be updated.
   * Calls the determineAnnotationStrings method to actually create the file update text.
   * @param annotation
   */
  async addAnnotation(annotation) {
    return new Promise(async (resolve, reject) => {
      try {
        logger.info(`${this.name}: adding annotation`)
        const currentByteLength = Buffer.byteLength(this.data)
        const page = this.pages[annotation.pageNumber]
        let newXrefTable = ['0 1', '0000000000 65535 f']

        let writeStrings = []
        let pageString = '', newAnnotsString = '', objToUpdate = ''
        const newAnnotationNumber = this.nextObjNum

        // check if this page has annotations on it already
        let pageUpdate = false
        if (page.annots) {
          if (page.annots.isArray) {
            // we need to update the whole page object because we need to add an new entry to the Annots array in the obj
            pageUpdate = true
            newAnnotsString = `\n/Annots [${page.annots.objs.join(' ')} ${newAnnotationNumber} 0 R]\n`
          } else {
            // we need to update the annots object for this page
            pageString = `${page.annots.objNum} 0 obj\n[ ${page.annots.objs.join(' ')} ${newAnnotationNumber} 0 R ]`
            objToUpdate = page.annots.objNum
          }
        } else {
          // the whole page object needs to be updated and an Annots arrays needs to be added
          pageUpdate = true
          newAnnotsString = `\n/Annots [${newAnnotationNumber} 0 R]\n`
          page.annots = {
            objNum: null, isArray: true, isObj: false, gen: 0, objs: []
          }
        }

        if (pageUpdate) {
          objToUpdate = page.objNum
          const temp = page.obj.replace(/\/Annots\s*\n*\[(.*?)\]/gms, '')
          const last = temp.lastIndexOf('>>')
          const beginning = temp.slice(0, last)
          const end = temp.slice(last)
          pageString = `${beginning}${newAnnotsString}${end}`
          this.objTable[page.objNum].occurrence += 1
          page.obj = pageString
        } else {
          this.objTable[page.annots.objNum].occurrence += 1
        }

        const writeString = PDF.removeEmptyNewlines(`${pageString}\nendobj\n`)
        writeStrings.push({ string: writeString, objNumber: objToUpdate, byteOffset: currentByteLength + 1 })
        page.annots.objs = [...page.annots.objs, `${newAnnotationNumber} 0 R`]
        newXrefTable = PDF.addToXrefTable(objToUpdate, 1, [currentByteLength + 1], newXrefTable)

        this.nextObjNum += 1
        const { strings, finalByteLength } = await this.createAnnotationStrings(newAnnotationNumber,
          annotation,
          (currentByteLength + 1) + Buffer.byteLength(writeString)
        )

        const offsets = strings.map(obj => obj.byteOffset)
        newXrefTable = PDF.addToXrefTable(newAnnotationNumber, offsets.length, offsets, newXrefTable)

        this.updateTrailer(newAnnotationNumber + offsets.length)
        this.lastStartXref = finalByteLength + 1

        const xrefTableString = `xref
${newXrefTable.join('\n')}
trailer
<<
${this.lastTrailer}
>>
startxref
${this.lastStartXref}
%%EOF`

        const finalStringArr = writeStrings.concat(strings)
        let finalString = ''
        finalStringArr.forEach(obj => finalString += obj.string)

        const newData = `
${finalString}
${xrefTableString}`

        this.docString += newData
        this.nextObjNum = newAnnotationNumber + offsets.length
        const newDataBuffer = Buffer.from(newData)
        this.data = Buffer.concat([this.data, newDataBuffer], newDataBuffer.length + this.data.length)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Creates the actual strings that will be appended to the pdf file
   * @param annotationNum
   * @param annotation
   * @param startingByteLength
   * @returns {{finalByteLength: *, strings: *}}
   */
  async createAnnotationStrings(annotationNum, annotation, startingByteLength) {
    let byteLength = startingByteLength
    let objStrings = []

    // Each annotation is 13 additional object for the document
    const objNums = Array.from({ length: 13 }, (_, i) => annotationNum + i)

    // This is needed when the annotation spans multiple lines. For the rectangle you need the lowest left corner and
    // upper most right corner
    const pdfPoints = annotation.rects.map(rect => rect.pdfPoints)
    const minX = Math.min(...pdfPoints.map(point => point.x))
    const minEndY = Math.min(...pdfPoints.map(point => point.endY))
    const maxEndX = Math.max(...pdfPoints.map(point => point.endX))
    const maxY = Math.max(...pdfPoints.map(point => point.y))

    // lower left x coord of rectangle
    const llx = (minX - 3).toFixed(3)
    // lower left y coord or rectangle
    const lly = (minEndY - 3).toFixed(3)

    // upper right x coord of rectangle
    const urx = (maxEndX + 3).toFixed(3)
    // upper right y coord of rectangle
    const ury = (maxY + 3).toFixed(3)

    // [ lower left corner, upper right corner ]
    const rect = [llx, lly, urx, ury]

    // [ x y endX y x endY endX endY ]
    let quadPoints = [], streamStrings = []
    for (const rect of pdfPoints) {
      const { x, y, endX, endY } = rect
      quadPoints = [
        ...quadPoints,
        x.toFixed(3),
        y.toFixed(3),
        endX.toFixed(3),
        y.toFixed(3),
        x.toFixed(3),
        endY.toFixed(3),
        endX.toFixed(3),
        endY.toFixed(3)
      ]

      // Each rectangle (line) in the annotation will paint 2 Cubic Bezier functions for each side of the rectangle.
      const firstCB = [
        (x - 3).toFixed(3), (endY + 3).toFixed(3), (x - 3).toFixed(3), (y - 3).toFixed(3), x.toFixed(3), y.toFixed(3)
      ]

      const secondCB = [
        (endX + 3).toFixed(3),
        (y - 3).toFixed(3),
        (endX + 3).toFixed(3),
        (endY + 3).toFixed(3),
        endX.toFixed(3),
        endY.toFixed(3)
      ]

      // This is the /Form dictionary stream that is where it tells the document to paint the rectangle.
      const formStreamString = `${x.toFixed(3)} ${endY.toFixed(3)} m
${firstCB.join(' ')} c
${endX.toFixed(3)} ${y.toFixed(3)} l
${secondCB.join(' ')} c
f`
      streamStrings.push(formStreamString)
    }

    // [ width, height ]
    const bbox = [0, 0, Math.ceil(urx - llx), Math.ceil(ury - lly)]
    const alpha = 0.3999994
    //const color = [1.0, 0.819611, 0.0] // this is an orangish-yellow (like what you see on Adobe)
    const color = [0.194, 0.757, 0.889] // this is a light blue

    // Make the write string for the new annotation
    const annoString = `
${annotationNum} 0 obj
<<
  /Type /Annot
  /Subtype /Highlight
  /Rect ${objNums[1]} 0 R
  /QuadPoints ${objNums[2]} 0 R
  /C ${objNums[3]} 0 R
  /CA ${alpha}
  /Border ${objNums[4]} 0 R
  /AP ${objNums[5]} 0 R
  /NM (annot-${annotationNum})
  /F 0
  /Contents <>
>>
endobj
`

    objStrings.push({ objNumber: annotationNum, byteOffset: byteLength, string: annoString })
    byteLength = byteLength + Buffer.byteLength(annoString)

    // Create the Rect object
    const rectString = `
${objNums[1]} 0 obj
[ ${rect.join(' ')} ]
endobj
`

    objStrings.push({ objNumber: objNums[1], byteOffset: byteLength, string: rectString })
    byteLength = byteLength + Buffer.byteLength(rectString)

    // Create the QuadPoints object
    const qpString = `
${objNums[2]} 0 obj
[ ${quadPoints.join(' ')} ]
endobj
`

    objStrings.push({ objNumber: objNums[2], byteOffset: byteLength, string: qpString })
    byteLength = byteLength + Buffer.byteLength(qpString)

    // Create the C (color) object
    const colorString = `
${objNums[3]} 0 obj
[ ${color.join(' ')} ]
endobj
`

    objStrings.push({ objNumber: objNums[3], byteOffset: byteLength, string: colorString })
    byteLength = byteLength + Buffer.byteLength(colorString)

    // Create the border object
    const borderString = `
${objNums[4]} 0 obj
[ 0.000000 0.000000 0.000000 ]
endobj
`

    objStrings.push({ objNumber: objNums[4], byteOffset: byteLength, string: borderString })
    byteLength = byteLength + Buffer.byteLength(borderString)

    // Create the AP (appearance stream) object
    const apString = `
${objNums[5]} 0 obj
<<
  /N ${objNums[6]} 0 R
>>
endobj
`

    objStrings.push({ objNumber: objNums[5], byteOffset: byteLength, string: apString })
    byteLength = byteLength + Buffer.byteLength(apString)

    // Create the AppearanceStream dictionary
    const apObjString1 = `
${objNums[6]} 0 obj
<<
  /BBox ${objNums[7]} 0 R
  /FormType 1
  /Matrix [
    1.0
    0.0
    0.0
    1.0
    0.0
    0.0
  ]
  /Resources <<
    /ExtGState <<
      /R0 <<
        /AIS false
        /CA ${alpha}
        /Type /ExtGState
        /ca ${alpha}
      >>
      /R1 <<
        /AIS false
        /BM /Multiply
        /Type /ExtGState
      >>
    >>
    /ProcSet [
      /PDF
    ]
    /XObject <<
      /ANForm ${objNums[9]} 0 R
    >>
  >>
  /Subtype /Form
  /Type /XObject
  /Length ${objNums[8]} 0 R
>>
stream`

    const apStreamString = `
/R0 gs
/R1 gs
/ANForm Do`

    const apObjString2 = `
endstream
endobj
`

    const apObjStringFull = `${apObjString1}${apStreamString}${apObjString2}`

    objStrings.push({ objNumber: objNums[6], byteOffset: byteLength, string: apObjStringFull })
    byteLength = byteLength + Buffer.byteLength(apObjStringFull)

    // Create the first BBox object
    const bboxString1 = `
${objNums[7]} 0 obj
[ ${bbox.join(' ')} ]
endobj
`
    objStrings.push({ objNumber: objNums[7], byteOffset: byteLength, string: bboxString1 })
    byteLength = byteLength + Buffer.byteLength(bboxString1)

    // Create the Appearance Stream length object
    const apStreamLength = Buffer.from(apStreamString).byteLength
    const apStreamLengthString = `
${objNums[8]} 0 obj
${apStreamLength}
endobj
`

    objStrings.push({ objNumber: objNums[8], byteOffset: byteLength, string: apStreamLengthString })
    byteLength = byteLength + Buffer.byteLength(apStreamLengthString)

    // Create the /ANForm dictionary
    const anFormString1 = `
${objNums[9]} 0 obj
<<
  /BBox [ ${bbox.join(' ')} ]
  /FormType 1
  /Group <<
    /S /Transparency
  >>
  /Matrix [
    1.0
    0.0
    0.0
    1.0
    0.0
    0.0
  ]
  /Resources <<
    /ProcSet [
      /PDF
    ]
    /XObject <<
      /Form ${objNums[11]} 0 R
    >>
  >>
  /Subtype /Form
  /Type /XObject
  /Length ${objNums[10]} 0 R
>>
stream`

    const anFormStream = `
/Form Do`
    const anFormString2 = `
endstream
endobj
`

    const anFormStringFull = `${anFormString1}${anFormStream}${anFormString2}`
    objStrings.push({ objNumber: objNums[9], byteOffset: byteLength, string: anFormStringFull })
    byteLength = byteLength + Buffer.byteLength(anFormStringFull)

    // Create ANForm length object
    const anFormLengthString = `
${objNums[10]} 0 obj
${Buffer.from(anFormStream).byteLength}
endobj
`

    objStrings.push({ objNumber: objNums[10], byteOffset: byteLength, string: anFormLengthString })
    byteLength = byteLength + Buffer.byteLength(anFormLengthString)

    // Create the actual Form object
    const formObjString1 = `
${objNums[11]} 0 obj
<<
  /BBox [ ${rect.join(' ')} ]
  /FormType 1
  /Matrix [ 1.0 0.0 0.0 1.0 -${rect[0]} -${rect[1]} ]
  /Resources <<
    /ProcSet [
      /PDF
    ]
  >>
  /Subtype /Form
  /Type /XObject
  /Length ${objNums[12]} 0 R
>>
stream`

    const formStreamString = `
${color.join(' ')} rg
0.8075 w
${streamStrings.join('\n')}`

    const formObjString2 = `
endstream
endobj
`

    const formStreamStringFull = `${formObjString1}${formStreamString}${formObjString2}`

    objStrings.push({ objNumber: objNums[11], byteOffset: byteLength, string: formStreamStringFull })
    byteLength = byteLength + Buffer.byteLength(formStreamStringFull)

    // Create ANForm length object
    const formStreamLengthString = `
${objNums[12]} 0 obj
${Buffer.from(formStreamString).byteLength}
endobj
`

    objStrings.push({ objNumber: objNums[11], byteOffset: byteLength, string: formStreamLengthString })
    byteLength = byteLength + Buffer.byteLength(formStreamLengthString)

    return { strings: objStrings, finalByteLength: byteLength }
  }

  /**
   * Pads a byte offset to 10 characters
   * @param offset
   * @returns {string}
   */
  static padByteOffset(offset) {
    return `${offset.toString().padStart(10, '0')} 00000 n`
  }

  /**
   * Creates an entry in an xref table
   * @param objNum
   * @param genOrTotal
   * @param offsets
   * @param table
   */
  static addToXrefTable(objNum, genOrTotal, offsets, table) {
    return [
      ...table, `${objNum} ${genOrTotal}`, ...offsets.map(offset => this.padByteOffset(offset))
    ]
  }

  /**
   * Cleans up a dictionary object by adding spaces and new lines where they should be
   * @param string
   */
  static cleanUpDictionary(string) {
    return string.replace(/\//g, ' /').replace(/(<<|>>)/g, '\n$1\n')
  }

  /**
   * Removes empty new lines
   * @param string
   */
  static removeEmptyNewlines(string) {
    return string.replace(/^[\n\r\s]*/gm, '')
  }

  /**
   * Returns the object at objNum in the PDF
   * @param objNum
   * @param genNum
   * @param occur
   * @returns {string}
   */
  getObjectAt(objNum, genNum = null, occur = null) {
    const occurrence = occur
      ? occur
      : this.objTable[objNum]
        ? this.objTable[objNum].occurrence
        : 0

    const gen = genNum
      ? genNum
      : this.objTable[objNum]
        ? this.objTable[objNum].gen
        : 0

    const objRegex = new RegExp(`([^\\d]${objNum}\\s+${gen}\\s+(?=(obj)))(.*?)(?=(endobj))`, 'gms')
    const matches = this.docString.match(objRegex)
    return matches ? matches[occurrence] : null
  }

  /**
   * Returns all references of an object in the file regardless of generation number
   * @param objNum
   */
  getAllGensOfObject(objNum) {
    const objRegex = new RegExp(`([^\\d]${objNum}\\s+\\d+\\s+(?=(obj)))(.*?)(?=(endobj))`, 'gms')
    return this.docString.match(objRegex)
  }

  /**
   * Cleans up temporary files
   */
  static cleanUp() {
    util.removeTmpFiles(['./temp.pdf', './decompressed.pdf'])
  }
}

module.exports = PDF
