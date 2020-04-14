const DocumentController = require('./controllers/doc.controller')
const express = require('express')
const router = express.Router()
const multer = require('multer')
const upload = multer()
const { logger } = require('./util/logger')
const util = require('./util')

/**
 * Get all documents
 */
router.get('/docs', DocumentController.getAllDocuments)

/**
 * Update document with _id :id
 */
router.put('/docs/:id', DocumentController.updateDocument)

/**
 * delete the document with matching id
 */
router.delete('/docs/:id', DocumentController.deleteDoc)

/**
 * Retrieve the file contents for a document
 */
router.get('/docs/:id/contents', DocumentController.getDocumentContents)

/**
 * Get approved documents for a project / jurisdiction
 */
router.get(
  '/docs/projects/:projectId/jurisdictions/:jurisdictionId',
  DocumentController.getDocumentsByProjectJurisdiction
)

/**
 * Extracts info from an excel document
 */
router.post(
  '/docs/upload/extractInfo', upload.single('file'), async (req, res) => {
    try {
      const result = await DocumentController.extractInfo(req, res)
      await util.removeTmpFiles(result.fileToRemove)
      logger.info({ req, res })
      logger.info(`Extracted info from ${req.file.originalname}`)
      res.send(result.jsonSheet)
    } catch (err) {
      logger.error({ req, res })
      logger.error(`Data extraction failed for file: ${req.file ? req.file.originalname : undefined}`)
      res.status(500).send(err)
    }
  })

/**
 * Upload a set of documents, up to 50
 */
router.post('/docs/upload', upload.array('files', 50), async (req, res) => {
  try {
    const docs = await DocumentController.uploadDocs(req, res)
    await util.removeTmpFiles(docs.filesToRemove)
    res.json({ files: docs.response })
    logger.info({ req, res })
  } catch (err) {
    console.log(err)
    res.status(500).send(err)
    logger.error({ req, res })
  }
})

/**
 * Download document with annotations
 */
router.post('/docs/:id/download', DocumentController.downloadOne)

/**
 * Download a zip of documents with annotations
 */
router.post('/docs/download', DocumentController.downloadMultiple)

/**
 * Removes an ID from the project or jurisdiction array for a doc
 */
router.delete('/docs/:id/:updateType/:removeId', DocumentController.removeFromDocArray)

/**
 * Adds a new ID to the project or jurisdiction array for a doc
 */
router.post('/docs/:id/:updateType/:newId', DocumentController.addToDocArray)

/**
 * delete the documents with matching list of id
 */
router.post('/docs/bulkDelete', DocumentController.bulkDeleteDocs)

/**
 * update / add to the documents with provided project or jurisdiction where the id matched with the provided id list
 */
router.post('/docs/bulkUpdate', DocumentController.bulkUpdateDocs)

/**
 * remove the provided project id from all documents' project list
 */
router.put('/docs/cleanProjectList/:projectId', DocumentController.cleanDocProjects)

/**
 * This API route is make sure the files about to be uploaded aren't duplicates
 */
router.post('/docs/verifyUpload', DocumentController.verifyUpload)

module.exports = router
