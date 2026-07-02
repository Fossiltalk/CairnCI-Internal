var urlSearch = new URLSearchParams(location.hash)
var customURL = JSON.parse(urlSearch.get('custom'));
var clientSidePdfGenerationConfig = customURL.clientSidePdfGenerationConfig;
window.Core.forceBackendType('ems');
//window.Core.setPDFWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_full']);
//Set the path for office workers
window.Core.setOfficeWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_office']);
window.Core.setOfficeAsmPath(clientSidePdfGenerationConfig['cs_pdftron_officeasm']); //cs_pdftron_officeresource
window.Core.setOfficeResourcePath(clientSidePdfGenerationConfig['cs_pdftron_officeresource']);

window.Core.setPDFResourcePath(clientSidePdfGenerationConfig['cs_pdftron_resource']);
window.Core.setPDFWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_lean']);
window.Core.setPDFAsmPath(clientSidePdfGenerationConfig['cs_pdftron_asm']);
//window.Core.setWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_external']);
window.Core.setWorkerPath(clientSidePdfGenerationConfig['cs_pdftron_lib']+'/core');
//Set the path for Fonts
window.Core.setCustomFontURL(clientSidePdfGenerationConfig['cs_vlocity_webfonts_main'] + '/');
window.Core.setExternalPath(clientSidePdfGenerationConfig['cs_pdftron_external']);


window.addEventListener('viewerLoaded', function() {    
  parent.postMessage({pdfMergeViewerLoadedExternal:true}, '*');      
  instance.UI.disableDownload(); // disable download feature
  instance.UI.disablePrint(); // disable print feature
  instance.UI.disableTools(); //disable tools
  
  instance.UI.disableElements(['searchButton','toolbarGroup-View','toolbarGroup-Annotate','toolbarGroup-Shapes','toolbarGroup-Insert','toolbarGroup-Edit','toggleNotesButton','toolbarGroup-FillAndSign', 'toolbarGroup-Forms','languageButton']);
});
  
  window.addEventListener('message', pdfMergeReceiveMessage, false);
  
  function pdfMergeReceiveMessage(event) {
    if (event.isTrusted && typeof event.data === 'object') {
      switch (event.data.type) {
        case 'PDF_MERGE_OPEN_DOCUMENT':
          const base64String = event.data.payload;
          var blob = base64ToBlob(base64String);
          event.target.instance.UI.loadDocument(blob, {  
            officeOptions: { 
              disableBrowserFontSubstitution: true,      
              formatOptions: {
                hideTotalNumberOfPages: true
              }
            }
          });
          window.removeEventListener("message", pdfMergeReceiveMessage);
          break;
        default:
          break;
      }
    }
  }

  var base64ToBlob = function(base64, contentType) {
    var binaryString = window.atob(base64);
    var len = binaryString.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; ++i) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    var type = contentType || 'application/pdf';
    return new Blob([bytes], { type: type });
};