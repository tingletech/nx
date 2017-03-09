#!/usr/bin/env node
'use strict';
var path = require('path');
var _ = require('lodash');
/* global -Promise */
// var Promise = require('bluebird');
var winston = require('winston');

/**
 * upload files to the "Files" tab
 * @param {Object} client - Nuxeo Client
 * @param {string} source - path to the local file
 * @param {Object} file - Node.js Stream
 * @param {string} destination - path on remote server
 */
var filesToExtraFiles = function filesToExtraFiles(client, source, file, destination){
  console.log(destination);
  var uploader = client.operation('Blob.Attach')
    .params({
      document: destination,
      save: true,
      xpath: 'files:files'
    })
    .uploader();
  uploader.uploadFile(file, function(fileIndex, fileObj, timeDiff) {
    uploader.execute(function (error, data) {
      if (error) {
        console.log('uploadError', error);
        throw error;
      } else {
        // `data` here is content of the file 
      }
    });
  });
};

/**
 * upload a new version of a file, updating the major version number
 * @param {Object} client - Nuxeo Client
 * @param {Object} file - Node.js Stream
 * @param {Object} remote - Nuxeo Document
 */
var forceFileToDocument = function forceFileToDocument(client,
                                                       file,
                                                       remote) {
  var options = { 'name': file.path };
  var checkin = client.operation('Document.CheckIn')
    .context({ currentDocument: remote })
    .input('doc:' + remote.path)
    .params({
      version: 'major'
    })
    .execute()
    .then(function(doc) {
      winston.debug(doc);
      var uploader = client.operation('Blob.Attach')
        .params({
          document: doc,
          save: true
        })
        .uploader();
      uploader.uploadFile(file, options, function(fileIndex, fileObj, timeDiff) {
        uploader.execute.then(function (data) {
            // `data` here is content of the file
        })
        .catch(function(error) {
            console.log('uploadError', error);
            throw error;
        });
      });
    }).catch(function(error) { console.log(error); throw error; });
}

/**
 * create a new document at a specific path
 * @param {Object} client - Nuxeo Client
 * @param {string} source - path to the local file
 * @param {Object} file - Node.js Stream
 * @param {string} upload_folder - path on remote server
 */
var fileToDirectory = function fileToDirectory(client, source, file, upload_folder){
  var uploader = client.operation('FileManager.Import')
                       .context({ currentDocument: upload_folder })
                       .uploader();
  var options = { 'name': file.filename };
  var doc = uploader.uploadFile(file, options, function(fileIndex, fileObj, timeDiff) {
    uploader.execute({
      path: path.basename(source)
    }, function (data) {
        console.log('upload', data);
        var doc = client.document(data.entries[0]);
        doc.set({'file:filename': file.filename });
        doc.save(function(error, doc) {
          if (error) { console.log(error); throw error; }
          console.log('updated file:filename');
        });
    }).catch(function(error) {
        console.log('uploadError', error);
        throw error;
    });
  });
};

var uploadExtraFiles = function uploadExtraFiles(client, args, source, file) {
  var check_url = 'path' + args.destination_document;
  client.schemas(['files']);
  client.document(args.destination_document[0]).fetch(function(error, doc) {
    if (error) { console.log(error); throw error; }
    var updated = [];
    doc.set({
      'files:files': updated
    });
    doc.save(function(error, doc) {
      if (error) { console.log(error); throw error; }
      filesToExtraFiles(client, source, file, args.destination_document[0]);
    });
  });

  client.request(check_url).get(function(error, remote) {
  });
};

/**
 * wrapper for uploading file to a Folder
 * @param {Object} client - Nuxeo Client
 * @param {Object} args - parsed dict of command line arguments
 * @param {string} source - path to the local file
 * @param {Object} file - Node.js Stream
 */
var uploadFileToFolder = function uploadFileToFolder(client, args, source, file){

  // upload directory must exist
  var check_url = 'path' + args.upload_folder;
  client.request(check_url).get().then(function(remote) {

    // upload directory must be Folderish
    if (remote.facets.indexOf('Folderish') >= 0){

      // does the file already exist on nuxeo?
      var check2_url = 'path' + args.upload_folder.replace(/\/$/, '') + '/' + file.filename;
      client.request(check2_url).get().then().catch(function(error) {
        if (error) {
          if (error.response.status === 404) {
            // does not exist yet; upload away
            fileToDirectory(client, source, file, args.upload_folder);
          } else {
            console.log(error);
            throw error;
          }
        }
        // file is on the server
        else { 
          if (args.force) {
            forceFileToDocument(client, file, remote);
          } else {
            console.log('file ' + check2_url  + ' exists on nuxeo; use `-f` to force');
          }
        }
      });
    }
    // not Folderish
    else { throw new Error('destination ' + check_url + ' is not Folderish'); } 
  }).catch(function(error) { throw error; });
};


/**
 * wrapper for uploading file to specific document path name
 * @param {Object} client - Nuxeo Client
 * @param {Object} args - parsed dict of command line arguments
 * @param {string} source - path to the local file
 * @param {Object} file - Node.js stream
 */
var uploadFileToFile = function uploadFileToFile(client, args, source, file){

  var upload_folder = path.dirname(args.upload_document);
  // change the file.filename to rename file on the move
  file.filename = path.basename(args.upload_document);

  // does the file already exist on nuxeo?
  var check_url = 'path' + args.upload_document;
  client.request(check_url).get(function(error, remote) {
    if (error) {
      if (error.code === 'org.nuxeo.ecm.core.model.NoSuchDocumentException') {
        // does not exist yet; upload away
        fileToDirectory(client, source, file, upload_folder);
      } else {
        console.log(error);
        throw error;
      }
    }
    // file is on the server
    else {
      if (args.force) {
        forceFileToDocument(client, file, remote);
      } else {
        console.log('file ' + check_url  + ' exists on nuxeo; use `-f` to force');
      }
    }
  });
};


/**
 * parse a path string into an array of parents
 */
var parsePath = function parsePath(docpath){
  // clean up string and split into an array
  docpath = docpath.replace(/^\//,'').replace(/\/$/,'').split('/');
  // reduce the array into an array of parent paths
  return _.reduce(docpath, function(result, n, z) {
    // want to reduce to an array, it starts as a String
    if (result.constructor === String) {
      result = [ '/' + result ];
    }
    result.push(result[z - 1] + '/' + n);
    return result;
  });
};

/**
 * create a new document at a specific path
 * @param {Object} client - Nuxeo Client
 * @param {Object} params - parameters to pass to {@code Document.Create}
 */
var createDocument = function createDocument(client, params, input){
  return new Promise(function(resolve, reject){
    client.operation('Document.Create')
          .params(params)
          .input(input)
          .execute()
          .then(function(data, response) {
            resolve(data);
          })
          .catch(function(error) { reject(error); });
  });
};

var formatDocumentEntityType = function formatDocumentEntityType(json) {
  console.log(json.uid + '\t' + json.type + '\t' + json.path );
};

/**
 * create a new document at a specific path
 * @param {Object} client - Nuxeo Client
 * @param {Object} args - parsed dict of command line arguments
 */
var makeDocument = function makeDocument(nuxeo, pathin, type, force, parents){
  // check if the document exists
  var check_url = 'path' + pathin;
  var input =  path.dirname(pathin);
  var params = {
    type: type,
    name: path.basename(pathin),
    properties: {
      'dc:title': path.basename(pathin),
    }
  };

  var request = nuxeo.request(check_url);

  return request.get().then(function(remote) {
    // Folder is alread on the server
    if (force) {
      return createDocument(nuxeo, params, input);
    } else if (! parents){
      console.log(pathin + ' exists on nuxeo; use `-f` to force');
    }
  }).catch(function(error) {
    if (error.response.status === 404) {
      // does not exist yet; create it
      return createDocument(nuxeo, params, input);
    } else {
      console.log(error);
      throw error;
    }
  });
};


/**
 * create parent directories
 */
var makeParents = function makeParents(client, docpath, type, force){
  // https://github.com/petkaantonov/bluebird/issues/134
  Promise.reduce(parsePath(docpath), function(memo, item) {
    return makeDocument(client, item, type, force, true).then(function(res) {
      if (res) { console.log(res); }
    }).catch(function(error) {
      console.log(error, docpath);
    });
  }, 0);
};


/**
 * list a specific path
 * @param {Object} client - Nuxeo Client
 * @param {Object} args - parsed dict of command line arguments
 */
var lsPath = function lsPath(nuxeo, path){
  // check path specific path
  var check_url = 'path' + path;
  nuxeo.request(check_url)
    .get()
    .then(function(remote) {
      formatDocumentEntityType(remote);
    })
    .catch(function(error){
      console.log(error); throw error;
    });

  // check the path for childern
  check_url = check_url.replace(/\/$/, '') + '/@children';
  nuxeo.request(check_url)
    .get()
    .then(function(remote) {
      remote.entries.forEach(function(entry){
        formatDocumentEntityType(entry);
      });
    })
    .catch(function(error){
      console.log(error); throw error;
    });
};

var nxql = function nxql(nuxeo, query){
  nuxeo.request()
        .path('query')
        .queryParams({'query': query})
        .get()
        .then(function(remote) {
          remote.entries.forEach(function(entry){
            formatDocumentEntityType(entry);
          });
        })
        .catch(function(error){
          console.log(error); throw error;
        });
};

var mv_to_folder = function mv_to_folder(client, from, to){
  client.document(from)
    .fetch(function(error, doc) {
      if (error) { console.log(error); throw error; }
      doc.move({
        target: to
      }, function(error, doc) {
        console.log('Successfully moved ' + doc.title + ', updated path: ' + doc.path);
      });
  });
};

module.exports = {
  uploadExtraFiles: uploadExtraFiles,
  uploadFileToFolder: uploadFileToFolder,
  uploadFileToFile: uploadFileToFile,
  parsePath: parsePath,
  makeParents: makeParents,
  makeDocument: makeDocument,
  lsPath: lsPath,
  nxql: nxql,
  mv_to_folder: mv_to_folder,
  formatDocumentEntityType: formatDocumentEntityType,
  fileToDirectory: fileToDirectory,
  filesToExtraFiles: filesToExtraFiles,
  createDocument: createDocument
};


/* Copyright © 2016, Regents of the University of California

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
 * Neither the name of the University of California nor the names
   of its contributors may be used to endorse or promote products
   derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

*/
