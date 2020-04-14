const mongoose = require('mongoose')
const Schema = mongoose.Schema

/**
 * What constitutes a legal document
 */
const DocumentSchema = new Schema({
  /**
   * Name of the documents
   */
  name: String,
  /**
   * Content of the document
   */
  content: Buffer,
  /**
   * Tags associated with the document
   */
  tags: Array,
  /**
   * User object of the person who uploaded the document
   */
  uploadedBy: Object,
  /**
   * Date of which the document was uploaded
   */
  uploadedDate: Date,
  /**
   * Citation of the document
   */
  citation: String,
  /**
   * Effective date of the document
   */
  effectiveDate: Date,
  /**
   * When the document was last modified
   */
  lastModifiedDate: Date,
  /**
   * List of jurisdiction ids to which this document is associates. Corresponds to the phlip-backend db
   */
  jurisdictions: Array,
  /**
   * List of project ids to which this document is associated. Corresponds to phlip-backend db
   */
  projects: Array,
  /**
   * Status of document
   */
  status: { type: String, enum: ['Draft', 'Approved'], default: 'Draft' }
})

module.exports = mongoose.model('Document', DocumentSchema)
