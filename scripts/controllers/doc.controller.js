const Document = require('../models/doc.model')
const fs = require('fs')
const { spawnSync } = require('child_process')
const Excel = require('exceljs')
const path = require('path')
const TMP_FILE_DIR = path.resolve('tmp')
const { logger } = require('../util/logger')
const { removeExtension, removeTmpFiles } = require('../util')
const archiver = require('archiver')
const PDF = require('../util/pdfHelper')

/* Allowed file types */
const allowedTypes = ['pdf', 'rtf', 'odt', 'doc', 'docx']

/**
 * Checks to see if there are other documents with the same project and jurisdiction
 * @param projectId
 * @param jurisdictionId
 * @param name
 * @returns {*}
 */
const checkExistence = (projectId, jurisdictionId, name) => {
  return Document.findOne({ projects: projectId, jurisdictions: jurisdictionId, name })
}

/**
 * Checks for duplicates before uploading
 * @param req
 * @param res
 */
const verifyUpload = async (req, res) => {
  let duplicateFiles = []
  const selectedFiles = req.body

  await Promise.all(selectedFiles.map(async file => {
    const hasDuplicate = await checkExistence(file.projects[0], file.jurisdictions[0], file.name)
    if (hasDuplicate) {
      duplicateFiles.push(file)
    }
  }))
  res.status(200).send(duplicateFiles)
  logger.info({ req, res })
}

/**
 * Saves documents to mongoDB, converts non-pdf to PDF
 * @param req
 * @param res
 * @returns {Promise<{response: Array, filesToRemove: Array}>}
 */
const uploadDocs = async (req, res) => {
  let response = [], filesToRemove = []
  const metadata = JSON.parse(req.body.metadata)

  await Promise.all(req.files.map(async (file, i) => {
    const pieces = file.originalname.split('.')
    const ext = pieces[pieces.length - 1]
    let pdfFile, docModel

    // Save contents to Doc model
    const md = metadata[file.originalname]

    const docObject = {
      name: file.originalname,
      uploadedBy: {
        firstName: req.body.userFirstName,
        lastName: req.body.userLastName,
        id: req.body.userId
      },
      lastModifiedDate: md.lastModifiedDate,
      uploadedDate: Date.now(),
      tags: md.tags,
      citation: md.citation,
      jurisdictions: md.jurisdictions,
      projects: md.projects,
      effectiveDate: md.effectiveDate
    }

    if (ext !== 'pdf') {
      // paths
      const nameWithoutSpaces = file.originalname.split(' ').join('_')
      const pathToFile = `${TMP_FILE_DIR}/${nameWithoutSpaces}`
      fs.writeFileSync(pathToFile, file.buffer)
      pieces.pop()
      const pathToPdf = `${TMP_FILE_DIR}/${pieces.join('')}.pdf`

      const convert = spawnSync('unoconv', ['-vvv', '-f', 'pdf', '-o', pathToPdf, pathToFile])

      if (convert.stdout) {
        logger.info(convert.stdout.toString())
      }
      if (convert.stderr) {
        logger.error(convert.stderr.toString())
      }

      pdfFile = fs.readFileSync(pathToPdf)
      docObject.content = Buffer.from(pdfFile)
      filesToRemove = [...filesToRemove, pathToFile, pathToPdf]

      // Add file to be removed later
    } else {
      pdfFile = file.buffer
      docObject.content = Buffer.from(pdfFile)
    }

    docModel = new Document(docObject)
    const document = await docModel.save()

    response = [...response, document]
  }))
  return { response, filesToRemove }
}

/**
 * Get everything but the file contents of a document
 * @param req
 * @param res
 */
const getAllDocuments = (req, res) => {
  if (req.query.projects) {
    getDocumentsWithProjectList(req, res)
  } else {
    Document.find({}, '-content', (err, docs) => {
      if (err) {
        res.status(500).send(err)
        logger.error({ req, res })
      } else {
        res.send(docs)
        logger.info({ req, res })
      }
    })
  }
}

/**
 * Returns a list of documents whose projects array contains project ids in the req.body.projectList
 * @param req
 * @param res
 */
const getDocumentsWithProjectList = (req, res) => {
  const projectList = req.query.projects.map(project => parseInt(project))
  Document.find(
    { projects: { $in: projectList } },
    '-content',
    (err, docs) => {
      if (err) {
        res.status(500).send(err)
        logger.error({ req, res })
      } else {
        const d = docs.map(doc => ({
          ...doc._doc,
          projects: doc.projects.filter(project => projectList.includes(project))
        }))
        res.send(d)
        logger.info({ req, res })
      }
    }
  )
}

/**
 * Just get the file contents of a document
 * @param req
 * @param res
 */
const getDocumentContents = (req, res) => {
  Document.findById(req.params.id, 'content', async (err, doc) => {
    if (err) {
      res.status(500).send(err)
      logger.error({ req, res })
    } else {
      res.send(doc)
      logger.info({ req, res })
    }
  })
}

/**
 * Extract info from req.body.infoSheet
 * @param req
 */
const extractInfo = req => {
  return new Promise((resolve, reject) => {
    const workbook = new Excel.Workbook()
    const infoSheet = req.file
    const pathToFile = `${TMP_FILE_DIR}/${infoSheet.originalname}`
    fs.writeFileSync(pathToFile, infoSheet.buffer)
    let infoSheetJson = {}

    try {
      workbook.xlsx.readFile(pathToFile).then(() => {
        let worksheet
        // have to account for the 'empty' worksheet in the front
        if (workbook._worksheets.length > 2) {
          workbook.eachSheet(sheet => {
            if (sheet.orderNo === 1) {
              worksheet = sheet
            }
          })
        } else {
          worksheet = workbook.getWorksheet(1)
        }

        // remove header
        worksheet.spliceRows(0, 1)

        // loop through each row and add to object
        worksheet.eachRow((row, index) => {
          // the key is the file name, which is technically the second column
          // because exceljs starts at 1 (face palm).
          const pieces = [...row.getCell(1).value.split('.')]
          let name = row.getCell(1).value
          if (pieces.length > 0) {
            if (allowedTypes.includes(pieces[pieces.length - 1])) {
              pieces.pop()
              name = pieces.join('.')
            }
          }

          infoSheetJson[name] = {
            fileName: row.getCell(1).value,
            jurisdictions: { name: row.getCell(2).value },
            effectiveDate: row.getCell(3).value,
            citation: row.getCell(4).value
          }
        })
        resolve({ jsonSheet: infoSheetJson, fileToRemove: [pathToFile] })
      })
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Used for when you need to update all properties
 * @param req
 * @param res
 */
const updateAllProperties = (req, res) => {
  const docId = req.params.id
  const metadata = req.body

  const docMetaObject = {
    citation: metadata.citation,
    jurisdictions: metadata.jurisdictions,
    projects: metadata.projects,
    effectiveDate: metadata.effectiveDate,
    status: metadata.status
  }

  Document.findByIdAndUpdate(docId, { $set: docMetaObject }, {
    overwrite: true,
    new: true
  }, (error, doc) => {
    if (error) {
      res.status(500).send(error)
      logger.error({ req, res })
    } else {
      res.send(doc)
      logger.info({ req, res })
    }
  })
}

/**
 * Adds a project to a document
 * @param req
 * @param res
 */
const addToDocArray = (req, res) => {
  const docId = req.params.id
  Document.findByIdAndUpdate(
    docId,
    { $addToSet: { [req.params.updateType]: parseInt(req.params.newId) } },
    (error, doc) => {
      if (error) {
        res.status(500).send(error)
        logger.error({ req, res })
      } else {
        res.sendStatus(200)
        logger.info({ req, res })
      }
    }
  )
}

/**
 * Removes an id from an array in the document
 * @param req
 * @param res
 */
const removeFromDocArray = (req, res) => {
  const docId = req.params.id
  Document.findByIdAndUpdate(
    docId,
    { $pull: { [req.params.updateType]: parseInt(req.params.removeId) } },
    (error, doc) => {
      if (error) {
        res.status(500).send(error)
        logger.error({ req, res })
      } else {
        res.sendStatus(200)
        logger.info({ req, res })
      }
    }
  )
}

/**
 * Updates the document. Only send what NEEDS to be updated. Don't send the entire document.
 * @param req
 * @param res
 */
const updateDocument = (req, res) => {
  const docId = req.params.id
  Document.findByIdAndUpdate(docId, { $set: { ...req.body } }, (error, doc) => {
    if (error) {
      res.status(500).send(error)
      logger.error({ req, res })
    } else {
      res.sendStatus(200)
      logger.info({ req, res })
    }
  })
}

/**
 * Retrieves documents that are associated to a project / jurisdictions
 * @param req
 * @param res
 */
const getDocumentsByProjectJurisdiction = (req, res) => {
  const projectId = parseInt(req.params.projectId)
  const jurisdictionId = parseInt(req.params.jurisdictionId)

  Document.find(
    { projects: projectId, jurisdictions: jurisdictionId, status: 'Approved' },
    '-content', (err, docs) => {
      if (err) {
        res.status(500).send(err)
        logger.error({ req, res })
      } else {
        res.send(docs)
        logger.info({ req, res })
      }
    }
  )
}

/**
 * Deletes a document
 * @param req
 * @param res
 */
const deleteDoc = (req, res) => {
  const docId = req.params.id
  Document.findByIdAndRemove(docId, (error, doc) => {
    if (error) {
      res.status(500).send(error)
      logger.error({ req, res })
    } else {
      const response = {
        message: 'Document successfully deleted',
        id: docId
      }
      res.status(200).send(response)
      logger.info({ req, res })
    }
  })
}

/**
 * Bulk deletes documents
 * @param req
 * @param res
 */
const bulkDeleteDocs = (req, res) => {
  const docIds = req.body.docIds
  Document.deleteMany({ _id: { $in: docIds } }, (error, result) => {
    if (error) {
      res.status(500).send(error)
      logger.error({ req, res })
    } else {
      res.status(200).send(result)
      logger.info({ req, res })
    }
  })
}

/**
 * Bulk updates documents
 * @param req
 * @param res
 */
const bulkUpdateDocs = (req, res) => {
  const metaData = req.body.meta
  const docIds = req.body.docIds
  const updateField = metaData.updateType
  let newData = undefined
  if (updateField !== 'status') {  // update array
    newData = metaData.updateProJur.id
    Document.updateMany(
      { _id: { $in: docIds } },
      { $addToSet: { [updateField]: newData } },
      { multi: true },
      (error, result) => {
        if (error) {
          res.status(500).send(error)
          logger.error({ req, res })
        } else {
          res.status(200).send(result)
          logger.info({ req, res })
        }
      }
    )
  } else {  // update single field
    newData = 'Approved'
    Document.updateMany(
      { _id: { $in: docIds } },
      { $set: { [updateField]: newData } },
      { multi: true },
      (error, result) => {
        if (error) {
          res.status(500).send(error)
          logger.error({ req, res })
        } else {
          res.status(200).send(result)
          logger.info({ req, res })
        }
      }
    )
  }
}

/**
 * Remove project's id from the document's project list. If a list of doc id passed in, remove the project id only
 * from the documents in the list, otherwise remove the project Id from all documents
 */
const cleanDocProjects = (req, res) => {
  const projectId = parseInt(req.params.projectId)
  const docIds = req.body.docIds
  Document.updateMany(
    docIds === undefined ? {} : { _id: { $in: docIds } },
    { $pull: { projects: projectId } },
    (error, result) => {
      if (error) {
        res.status(500).send(error)
        logger.error({ req, res })
      } else {
        res.status(200).send(result)
        logger.info({ req, res })
      }
    }
  )
}

/**
 * Sorts through all of the documents annotations and separates them out by page. So they can be added that way.
 * @param annotations
 */
const getAnnotationsForDocByPage = annotations => {
  let annotsByPage = {}
  // split out annotations by page
  for (const annot of annotations) {
    if (annot.startPage !== annot.endPage) {
      // this annotation has rectangles on multiple pages. Separate them so they are added as multiple annotations
      let i = annot.startPage
      while (i <= annot.endPage) {
        const rectsForPage = annot.rects.filter(rect => rect.pageNumber === i)
        const annotation = { pageNumber: i, rects: rectsForPage }
        if (annotsByPage[i]) {
          annotsByPage[i] = [...annotsByPage[i], annotation]
        } else {
          annotsByPage[i] = [annotation]
        }
        i++
      }
    } else {
      const annotation = { pageNumber: annot.startPage, rects: annot.rects }
      if (annotsByPage[annot.startPage]) {
        annotsByPage[annot.startPage] = [...annotsByPage[annot.startPage], annotation]
      } else {
        annotsByPage[annot.startPage] = [annotation]
      }
    }
  }

  return annotsByPage
}

/**
 * Loops through all of the annotations for a pdf and adds them page by page
 * @param content
 * @param annotations
 * @param name
 * @returns {Promise<PDF>}
 */
const addAnnotations = (content, annotations, name) => {
  return new Promise(async (resolve, reject) => {
    try {
      const pdf = new PDF(content, name)
      await pdf.initialize()
      const annotsByPage = getAnnotationsForDocByPage(annotations)

      // add all of the annotations page by page
      for (let page of Object.keys(annotsByPage)) {
        for (let annotation of annotsByPage[page]) {
          await pdf.addAnnotation(annotation)
        }
      }
      resolve(pdf)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Handles downloading documents. This creates a zip file of all of the documents requested. If annotations were passed
 * into the request, then the annotations are added to the PDF document before being saved.
 */
const downloadMultiple = async (req, res) => {
  let appended = 0, total = req.body.docs.length, names = []

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename=files.zip')
  const archive = archiver('zip', { zlib: { level: 9 } })

  archive.on('error', err => {
    res.send(err)
    logger.error({ req, res })
  })

  archive.on('close', () => {
    logger.info({ req, res })
  })

  archive.on('entry', () => {
    appended += 1
    if (appended === total) {
      archive.finalize()
      archive.pipe(res)
    }
  })

  archive.on('end', () => {
    logger.info({ req, res })
  })

  for (let i = 0; i < req.body.docs.length; i++) {
    const document = req.body.docs[i]
    try {
      logger.info('')
      const doc = await Document.findById(document._id, { name: true, content: true, effectiveDate: true })
      const { name: nameWithoutExtension, extension } = removeExtension(doc.name)
      let name = names.includes(doc.name)
        ? `${nameWithoutExtension} (${names.filter(name => doc.name === name).length})`
        : nameWithoutExtension

      name = `${name}${extension === 'pdf' ? '.pdf' : `.${extension}.pdf`}`
      names.push(doc.name)
      logger.info(`${doc.name}: starting processing`)

      if (document.annotations.length > 0) {
        // there are annotations for this document
        try {
          const pdf = await addAnnotations(doc.content, document.annotations, doc.name)
          logger.info(`${doc.name}: finished adding annotations`)
          archive.append(pdf.data, { name })
          logger.info(`${doc.name}: added document to zip`)
        } catch (err) {
          logger.error(`${doc.name}: ERROR processing document`)
          archive.append(doc.content, { name })
          logger.info(`${doc.name}: added errored document to zip anyway...`)
        }
      } else {
        logger.info(`${doc.name}: does not have annotations`)
        archive.append(doc.content, { name })
        logger.info(`${doc.name}: added document to zip`)
      }
    } catch (err) {
      logger.error({ req, res })
      res.status(500).send(err)
    }
  }
}

/**
 * Download One Document. Adds annotations to the document if they exist
 * @param req
 * @param res
 */
const downloadOne = async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id, { name: true, content: true })
    const { name } = removeExtension(doc.name)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`)
    if (req.body.annotations.length > 0) {
      try {
        const pdf = await addAnnotations(doc.content, req.body.annotations, doc.name)
        logger.info(`${doc.name}: finished adding annotations`)
        logger.info(`${doc.name}: sending document`)
        res.setHeader('Content-Length', pdf.data.length)
        res.send(pdf.data)
      } catch (err) {
        logger.error(`${doc.name}: ERROR adding annotations`)
        logger.error(`${doc.name}: sending document without annotations`)
        logger.error(`${doc.name}: ${err}`)
        res.setHeader('Content-Length', doc.content.length)
        res.send(doc.content)
      }
    } else {
      logger.info(`${doc.name}: does not have annotations. sending file...`)
      res.setHeader('Content-Length', doc.content.length)
      res.send(doc.content)
    }
    logger.info({ req, res })
  } catch (err) {
    logger.error({ req, res })
    res.status(500).send(err)
  }
}

module.exports = {
  uploadDocs,
  getAllDocuments,
  verifyUpload,
  getDocumentContents,
  extractInfo,
  updateAllProperties,
  getDocumentsByProjectJurisdiction,
  deleteDoc,
  bulkDeleteDocs,
  bulkUpdateDocs,
  cleanDocProjects,
  addToDocArray,
  removeFromDocArray,
  updateDocument,
  downloadMultiple,
  downloadOne,
  addAnnotations,
  getAnnotationsForDocByPage
}
