(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.processImageTokenData = factory());
}(this, (function () { 'use strict';

const imageTokenJsonKey = 'src';

function processImageTokenData(docXTokenData, action) {
    return new Promise(function(resolve, reject) {
        let imageTokenList = [];
        let ImageContentBlob = {};
        let ImageSizeMap = {};

        function processImageModule(){
            var opts = {}
            opts.centered = false;
            opts.getImage=function(tagValue, tagName) {
                var imageBlob = ImageContentBlob[tagValue[imageTokenJsonKey]];
            
                if(imageBlob){
                    var imgBlob = removeBlobPrefix(ImageContentBlob[tagValue[imageTokenJsonKey]]);
                    if(imgBlob)
                        return base64ToArrayBuffer(imgBlob);
                    else
                        return '';
                } else
                    return '';
            }
            
            opts.getSize=function(img, tagValue, tagName) {
                if(ImageSizeMap[tagValue[imageTokenJsonKey]] == undefined) {
                    return [0, 0];
                }
                var actualWidth = ImageSizeMap[tagValue[imageTokenJsonKey]].width;
                var actualHeight = ImageSizeMap[tagValue[imageTokenJsonKey]].height;

                if(tagValue.height && tagValue.width) {
                    return [tagValue.width, tagValue.height];
                } else if(tagValue.height) {
                    var height = tagValue.height;
                    var width = (height * actualWidth) / actualHeight;
                    return [width, height];
                } else if(tagValue.width) {
                    var width = tagValue.width;
                    var height = (width * actualHeight) / actualWidth;
                    return [width, height];
                } else {
                    return [actualWidth, actualHeight];
                }
            }
            var imageModule=new ImageModule(opts);
            return imageModule;
        }

        function filterImageTokenData(tokenData){
            //var imageTokenFilterList = [];
            for(var token in tokenData) {
                if(token.startsWith('IMG_')){
                    if(tokenData[token][imageTokenJsonKey] !== undefined ) {
                        imageTokenList.push(tokenData[token][imageTokenJsonKey]);
                    }
                }
                else if(Array.isArray(tokenData[token])){
                    // Loop over the list if it is a repeated content
                    var repeatedContent = tokenData[token];
                    repeatedContent.forEach(function(rc) {
                        // BUG FIX: Removed .concat() as it does not update the given array.
                        filterImageTokenData(rc);
                    });
                }
                else if(typeof tokenData[token] === 'object') {
                    // BUG FIX: Removed .concat() as it does not update the given array.
                    filterImageTokenData(tokenData[token]);
                }
            }
        }

        function isStaticResourceUrl(str) {
            if(str)
                return str.includes('/resource/');
            return null;
        }

        function fetchImageContent(urls) {
            Promise.all(urls.map(url => fetch(url))).then(responses => 
                Promise.all(responses.map(res => res.blob()))
            ).then(imageBlobs => {
                var i = 0;
                var size = urls.length;
                urls.forEach(url => {
                    var reader = new FileReader();
                    reader.readAsDataURL(imageBlobs[i++]); 
                    reader.onloadend = function() {
                       ImageContentBlob[url] = reader.result;
                        size = size -1;
                        if(size === 0) {
                            Promise.all(Object.keys(ImageContentBlob).map(key => getImageSize(key, ImageContentBlob[key])))
                                .then(imageDimensions => {
                                imageDimensions.forEach(dimension => {
                                    ImageSizeMap = deepmerge(ImageSizeMap, dimension)
                                })
                                // BUG FIX: Module is created only after all data  populated.
                                var imageModule = processImageModule();
                                var result = {
                                    'imageModule': imageModule
                                }
                                resolve(result);
                            }); 
                        }
                    }
                });
            });
        }

        function getImageSize(imageUrl, dataUri) {
            return new Promise(function(resolve, reject) {
                var image = new Image();
                image.onload = function() {
                    var imageSize = {};
                    imageSize.height = image.height;
                    imageSize.width = image.width;
                    
                    var result = {};
                    result[imageUrl] = imageSize;
                    
                    resolve(result);
                };
                image.src = dataUri;
            });
        }

        function removeBlobPrefix(blobValue) {
            if(blobValue) {
                return blobValue.substring(blobValue.indexOf(',') + 1);
            } else return '';
        }

        function getImageContent(idList) {
            if(typeof action === 'function') {
                let inputMap = {'imageKeyList':idList};

                let dataMap = getDataMap(inputMap);
                let dataMapValue = {
                    className: 'DocgenAppHandler',
                    methodName: 'getImageContent',
                    inputMap: dataMap.inputMap,
                    optionsMap: dataMap.optionsMap
                };

                action(dataMapValue).then(function(result){    
                    if(!result.error) { 
                        processImageBlobResults(result.result, idList);
                    } else {
                        let errorMessage = `${result.result.error}`;
                        let error = {
                            showToUser:true,
                            message: errorMessage
                        };
                        console.error('error: ', error);
                        reject(error);
                    }    
                }).catch(error => {
                    console.error('error: ', error);
                    reject(error);
                  });
            }
            else {
                action.getImageContent(idList).then(function(result) {
                    if(!result.error) { 
                        processImageBlobResults(result, idList);
                    } else{
                        let errorMessage = `${result.result.error}`;
                        let error = {
                            showToUser:true,
                            message: errorMessage
                        };
                        console.error('error: ', error);
                        reject(error);
                    } 
                }, function(error) {
                    console.error('error: ', error);
                    let errorMessage = `${error.message}`;
                    let errorDetails = {
                        showToUser:true,
                        message: errorMessage
                    };
                    reject(errorDetails);
                }).catch(error => {
                    console.error('error: ', error);
                    reject(error);
                  });
            }
        }

        function deleteTokensWithInvalidId(tokenData, values) {
            //var imageTokenFilterList = [];
            for(var token in tokenData) {
                if(token.startsWith('IMG_')){
                    // get url of each IMG_Token 
                    if(values.indexOf(tokenData[token][imageTokenJsonKey]) >= 0) {
                        delete tokenData[token]; 
                    }
                }
                else if(Array.isArray(tokenData[token])){
                    // Loop over the list if it is a repeated content
                    var repeatedContent = tokenData[token];
                    repeatedContent.forEach(function(rc) {
                        deleteTokensWithInvalidId(rc, values);
                    });
                }
                // handle single line item scenario
                else if(typeof tokenData[token] === 'object') {
                    deleteTokensWithInvalidId(tokenData[token], values);
                }
            }
        }

        function processImageBlobResults(result, idList) {
            console.log('### getImageContent response: ', result);
            if(result.invalidIds) {
                deleteTokensWithInvalidId(docXTokenData, result.invalidIds);
            }
                
            if(result.imageContentMap)
                ImageContentBlob = deepmerge(ImageContentBlob, result.imageContentMap);
            
            if(result.hasMoreData) {
                var imagesLeft = idList.slice(result.nextChunkStartIndex);
                getImageContent(imagesLeft);
            } else {
                var errors = [];

                if(result.message) {
                    var error = result.message
                    error.showToUser = true
                    errors.push(error);
                }
                
                Promise.allSettled(Object.keys(ImageContentBlob).map(key => getImageSize(key, ImageContentBlob[key]))).then(function(imageDimensions) { 
                    imageDimensions.forEach(dimension => {
                        if(dimension.reason) {
                            errors.push(dimension.reason);
                        } else
                            ImageSizeMap = deepmerge(ImageSizeMap, dimension.value);
                    })

                    // FIX: Module is created only after all data is populated.
                    var imageModule = processImageModule();
                    var resultObj = { 
                        'imageModule': imageModule 
                    };
                    
                    if(errors.length)
                    {
                        console.error('error: ', errors);
                        resultObj.errors = errors;
                    }
                    resolve(resultObj);
                })
            }
        }

        function base64ToArrayBuffer(base64) {
            var binary_string = window.atob(base64);
            var len = binary_string.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
                bytes[i] = binary_string.charCodeAt(i);
            }
            return bytes.buffer;
        }

        function getDataMap(inputMap) {
            const options = {
                useQueueableApexRemoting: false,
                useContinuation: false
            };
            return {
                inputMap: inputMap,
                optionsMap: options
            }
        }

        filterImageTokenData(docXTokenData);

        if(!imageTokenList.length) {
            resolve(true);
            return;
        }
        
        if(isStaticResourceUrl(imageTokenList[0])) {
            var urls = [...new Set(imageTokenList)];
            fetchImageContent(urls);
        } else {
            var idList = [...new Set(imageTokenList)];
            getImageContent(idList);
        }
    });
};

var imageTokenData = processImageTokenData;
return imageTokenData;
})));