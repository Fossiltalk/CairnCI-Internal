var clientSidePdfGenerationConfig;
function handleMergeMessage(event) {
    if (event.isTrusted && typeof event.data === 'object') {
        switch (event.data.type) {
            case 'LOAD_MERGE_CORE_CONTROLS':
                clientSidePdfGenerationConfig = JSON.parse(event.data.params);
                console.log(clientSidePdfGenerationConfig);
                var script = document.createElement('script');
                script.onload = function () {
                    init(clientSidePdfGenerationConfig);
                };
                script.src = encodeURI(clientSidePdfGenerationConfig['core_controls']);

                document.head.appendChild(script);
                window.removeEventListener("message", handleMergeMessage);
                break;
            default:
                break;
        }
    }
}

window.addEventListener("message", handleMergeMessage);


parent.postMessage({ type: 'MERGE_REQUEST_PARAMS' }, '*');


function init(clientSidePdfGenerationConfig) {
  console.log(`%c initialize CoreControls `, 'background: red; color: white;');
    window.Core.forceBackendType('ems');
    //window.Core.setPDFWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_full']);
    window.Core.setPDFWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_lean']);
    window.Core.setOfficeWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_office']);
    window.Core.setPDFResourcePath(clientSidePdfGenerationConfig['cs_pdftron_resource']);
    window.Core.setPDFAsmPath(clientSidePdfGenerationConfig['cs_pdftron_asm']);
    window.Core.setExternalPath(clientSidePdfGenerationConfig['cs_pdftron_external']);
    window.Core.setWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_lib']+'/core');

    //Set the path for Fonts
    window.Core.setCustomFontURL(clientSidePdfGenerationConfig['cs_vlocity_webfonts_main'] + '/');

    //Set the path for office workers
    window.Core.setOfficeAsmPath(clientSidePdfGenerationConfig['cs_pdftron_officeasm']);
    window.Core.setOfficeResourcePath(clientSidePdfGenerationConfig['cs_pdftron_officeresource']);
    window.Core.disableEmbeddedJavaScript(true)

    console.log(Core);
    console.log(window.Core.PDFNet);

    var pdfTronLicense = atob(clientSidePdfGenerationConfig.pdfIntegrationConfig);

    mergeDocuments(clientSidePdfGenerationConfig.pdfList, pdfTronLicense)
    .then(function(pdfContent){
        console.log(`%c Post message back to parent `, 'background: green; color: white;');
        pdfContent.getFileData().then(function(pdf){
          var base64Data = arrayBufferToBase64(pdf);
          parent.postMessage({type: 'PDF_MERGE_GENERATION_COMPLETE', payload: base64Data}, '*')
        })
    }, function(error) {

    });
}

function arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes = new Uint8Array( buffer );
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
      binary += String.fromCharCode( bytes[ i ] );
  }
  return window.btoa( binary );
}

function mergeDocumentsWorking(arrayOfIds, pdfTronLicense, nextCount = 1, doc = null) {
    return new Promise(async function(resolve, reject) {
      getFileBlobById(pdfTronLicense, arrayOfIds[0]).then(function(result){
        doc = result;
        getFileBlobById(pdfTronLicense, arrayOfIds[nextCount]).then(function(result){
          newDoc = result;
          var pages = [];
          for (var i = 0; i < newDoc.numPages; i++) {
            pages.push(i + 1);
          }
          var newPageCount = doc.getPageCount() + newDoc.getPageCount();
  
          return doc.insertPages(newDoc, pages, doc.getPageCount() + 1).then(function() {
              return resolve(doc);
          });
        });
      })
    })
  }
  
  function mergeDocuments(arrayOfIds, pdfTronLicense, nextCount = 1, doc = null) {
    return new Promise(async function(resolve, reject) {
     if(!doc) {
      getFileBlobById(pdfTronLicense, arrayOfIds[arrayOfIds.length-1]).then(function(result){
        doc = result;
        return resolve(mergeNextDocument(pdfTronLicense, arrayOfIds,nextCount, doc));
      })
      } else {
        return resolve(mergeNextDocument(pdfTronLicense, arrayOfIds,nextCount, doc));
      }
    }).then(function(res) {
        return res.next ?
          mergeDocuments(arrayOfIds, pdfTronLicense, nextCount + 1, res.doc) :
          res.doc;
      });
  }
  
  function mergeNextDocument(pdfTronLicense,arrayOfIds,nextCount, doc ) {
  return new Promise(async function(resolve, reject) {
    getFileBlobById(pdfTronLicense, arrayOfIds[arrayOfIds.length-1-nextCount]).then(function(result){
      newDoc = result;
      var pages = [];
      for (var i = 0; i < newDoc.numPages; i++) {
        pages.push(i + 1);
      }
      return newDoc.insertPages(doc).then(function() {
          return resolve({
            next: arrayOfIds.length - 1 > nextCount,
            doc: newDoc,
          });
      });
    });
    });
  }
  
  // initialize Document object using low-level apis
  function createDocument(pdfTronLicense, blob) {
    var url = URL.createObjectURL(blob)
    return new Promise(async function(resolve, reject) {
      // 'file.pdf' is temp name, 'pdf' is file type
      Core.getDefaultBackendType().then(function(backendType) {
        lic = pdfTronLicense;
        const options = {
            workerTransportPromise: Core.initPDFWorkerTransports(backendType, {},lic),
            l: lic, extension: 'pdf'
        };
        Core.createDocument(blob, options).then(function(doc){
          return resolve(doc);
        });
      });
    })
  }
  
  function getFileBlobById(pdfTronLicense, contentVersionId){
    return new Promise(function (resolve, reject){
        var blobData = base64ToBlob(contentVersionId);
          createDocument(pdfTronLicense, blobData).then(function(result) {
            return resolve(result);
          });
    });    
  }
  
  // helper function to turn base64 to blob
  function base64ToBlob(base64) {
    var binaryString = atob(base64);
    var len = binaryString.length;
    var bytes = new Uint8Array(len);
    for (let i = 0; i < len; ++i) {
      bytes[i] = binaryString.charCodeAt(i);
    }
  
    return new Blob([bytes], { type: 'application/pdf' });
  };