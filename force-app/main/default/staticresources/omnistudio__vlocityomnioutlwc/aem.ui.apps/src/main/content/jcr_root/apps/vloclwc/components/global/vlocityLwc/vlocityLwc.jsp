<%@page session="false"
        import="com.day.cq.wcm.webservicesupport.Configuration,
    			org.apache.sling.api.resource.ModifiableValueMap,
                com.day.cq.wcm.webservicesupport.ConfigurationManager,
                com.day.cq.wcm.foundation.Placeholder,
                com.adobe.cq.mcm.salesforce.SalesforceClient,
                com.adobe.cq.mcm.salesforce.SalesforceException,
                com.adobe.cq.mcm.salesforce.SalesforceResponse,
				com.adobe.granite.crypto.CryptoSupport,
                com.day.cq.i18n.I18n" %>
<%--
Vlocity Omniscript Component
Handles authentication using cloudservices configureation and launches the lwc
--%>
<%@include file="/libs/foundation/global.jsp"%>

<% %><cq:defineObjects />

<%@page contentType="text/html; charset=utf-8" %>

<% // Pass server's Salesforce-AEM CloudServices to client page
    I18n i18n = new I18n(slingRequest.getResourceBundle(currentPage.getLanguage(false)));
    boolean cloudConfigFound = false;
    Resource configResource = null;
    String salesforceConfigPath = resource.getValueMap().get("cloudserviceconfig","");
    Configuration salesforceConfig = null;
    String[] cloudConfigs = pageProperties.getInherited("cq:cloudserviceconfigs", new String[]{});
    ConfigurationManager configurationManager = resourceResolver.adaptTo(ConfigurationManager.class);
    CryptoSupport cryptoSupport = sling.getService(CryptoSupport.class);
	String id = "vlocid" + String.valueOf(Math.abs(resource.getPath().hashCode() - 1));

    if(cloudConfigs.length>0){
        if(salesforceConfigPath!="")
			salesforceConfig = configurationManager.getConfiguration(salesforceConfigPath);
        if(salesforceConfig ==null)
        	salesforceConfig = configurationManager.getConfiguration("salesforce",cloudConfigs);
        if(salesforceConfig!=null){
            cloudConfigFound = true;
            configResource = salesforceConfig.getResource();
        }
    }
    
    // draw placeholder for UI mode touch
    boolean isAuthoringUIModeTouch = Placeholder.isAuthoringUIModeTouch(slingRequest);
    if (isAuthoringUIModeTouch) {
        %>
                <%= Placeholder.getDefaultPlaceholder(slingRequest, component, "") %>
        <%
    }

    if(cloudConfigFound){
        // Set Salesforce Client
        SalesforceClient salesforceClient = new SalesforceClient();
        SalesforceResponse salesforceResponse = new SalesforceResponse();
        
        salesforceClient.setAccessToken(salesforceConfig.get("accesstoken",""));
        salesforceClient.setClientId(salesforceConfig.get("customerkey",""));
        salesforceClient.setClientSecret(cryptoSupport.unprotect(salesforceConfig.get("customersecret","")));
        salesforceClient.setInstanceURL(salesforceConfig.get("instanceurl",""));
        salesforceClient.setPath(salesforceConfig.get("authorizationUrl",""));

        String refreshtoken = salesforceConfig.get("refreshtoken","");
        if (cryptoSupport.isProtected(refreshtoken)){
            refreshtoken = cryptoSupport.unprotect(refreshtoken);
        }
        salesforceClient.setRefreshToken(refreshtoken);

        try{
            salesforceResponse = salesforceClient.refreshAccessToken();
        }catch(SalesforceException se){
            %>
			<div style="padding: 15px 0px">There has been a SalesforceException in refreshing the Access Token:
				<pre style="padding: 15px 30px"><%= se %></pre>
			</div>
            <%
        }

		ModifiableValueMap sfCfgMap = salesforceConfig.getResource().getChild("jcr:content").adaptTo(ModifiableValueMap.class);

        sfCfgMap.put("accesstoken",salesforceClient.getAccessToken());
    	salesforceConfig.getResource().getChild("jcr:content").getResourceResolver().commit();

        boolean useProxy = resource.getValueMap().get("useProxy", false);
        boolean useLocalDefProp = resource.getValueMap().get("useLocalDef", false);
        String sNSOverride = resource.getValueMap().get("sNSOverride","");
        String omniscriptElement = resource.getValueMap().get("omniscriptElement","");
        String layout = resource.getValueMap().get("layout","");
		Boolean isNewport = layout != null && layout.equals("newport");
        String prefill = resource.getValueMap().get("prefill","").replace("\"", "\\\"");
        String proxyUrl = useProxy ? resource.getValueMap().get("proxyURL","") : "";
        String instanceURL = salesforceConfig.get("instanceurl","");

        // Resource loading 
        Boolean loadSldsResources = resource.getValueMap().get("loadSldsResources", false);
        Boolean loadNewportResources = resource.getValueMap().get("loadNewportResources", false);
        Boolean loadVlocityPdf = resource.getValueMap().get("loadVlocityPdf", false);
        String googleMapsApiKey = resource.getValueMap().get("googleMapsApiKey", "");
        %>

            <!doctype html>
			<html lang="en">
                <head>
                    <meta charset="utf-8"/>
                    <title>Vlocity OmniScript LWC Components</title>
                    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
                    <% if (googleMapsApiKey != "") {%>
                    <script type="text/javascript"
                        src="https://maps.googleapis.com/maps/api/js?key=<%=googleMapsApiKey %>&libraries=places">
                    </script>
                    <%}%>
                    <cq:includeClientLib js="aem-vlocity-lwc" />
                    <% if (loadSldsResources) {%>
                    <cq:includeClientLib css="aem-vlocity-lwc-slds" />
                    <%}%>
                    <% if (loadNewportResources) {%>
                    <cq:includeClientLib css="aem-vlocity-lwc-nds" />
                    <%}%>
                    <cq:includeClientLib css="aem-vlocity-lwc-vlocityresources" />
                    <% if (loadVlocityPdf) {%>
                    <cq:includeClientLib js="aem-vlocity-lwc-pdf" />
                    <%}%>
                    <script src="//cdnjs.cloudflare.com/ajax/libs/jsforce/1.9.1/jsforce.min.js"></script>
                </head>
                <body>
                    <% if (isAuthoringUIModeTouch) {
            		%>
                    <div style="text-align:center; font-size: 1.1em;">
                        <div>Your OmniScript will be displayed here at runtime.</div>
                    <div style="padding: 15px 30px; font-size: 0.9em;"><pre style="font-family: 'Lucida Console', 'Courier New', monospace;">&lt;<%= omniscriptElement%>&gt;</pre></div>
                    </div>
                    <%
                    } else { %>
                    <noscript>
                        <div class="unsupported">
                            <div class="unsupported_title">LWC app can't be loaded!</div>
                            <div class="unsupported_message">This application requires javascript to work properly.</div>
                        </div>
                    </noscript>
                    <div id="outdated" style="display: none">
                        <div class="unsupported">
                            <div class="unsupported_title">App can't be loaded!</div>
                            <div class="unsupported_message"></div>
                        </div>
                    </div>
                    <script nomodule>const {
                        outdated
                      } = window;
                      outdated.style.display = 'unset';
                      outdated.querySelector('.unsupported_message').textContent =
                        'This application requires a more recent version of your browser';</script><script defer="defer">

                      /**
                       * A sample connection that uses jsForce to request data from the backend.
                       * This sample connection is for demo purposes and can be used to test
                       * the OmniOut LWC project locally. This connection sample is not intended
                       * to be used as production connection code.
                       **/
                      function JSForceConnectionExample_<%= id%>() {
                
                        const connection = new jsforce.Connection({
                          // Set your jsForce configuration here
                          accessToken: '<%= salesforceConfig.get("accesstoken","") %>',
                          instanceUrl: '<%= instanceURL%>',
                            proxyUrl: '<%= proxyUrl %>'
                        });
                
                        /**
                         * Expose the request method
                         **/
                        this.request = request;
                
                        /**
                         * @type {string} The namespace of the package
                         **/
                        this.namespace = '<%= sNSOverride%>';
                
                        /**
                         * Instance Url for salesforce connection
                         **/
                        this.instanceUrl = connection.instanceUrl;
                
                        /**
                         * A function that executes the HTTP requests.
                         * @type {string} The target URL.
                         * @type {Object} The data that will be sent to the target URL.
                         **/
                        function request(url, data) {
                          return connection.requestPost(url, data);
                        }
                      }

                      /**
                       * Once the component is ready, an event is dispatched to let the DOM knows that a connection is expected.
                       **/
                      document.addEventListener('omnioutcomponentready', evt => {
                        if (evt.detail && evt.detail.omnioutcomponent) {
                          evt.srcElement.connection = new JSForceConnectionExample_<%= id%>();
                        }
                      });
                    </script>

                    <!-- OmniScript target -->
					<div id="<%= id %>-container" class="aem-lwc">
                    </div>

                    <script>
                        function addElement<%= id %>() {

                            let wrapper = document.getElementById("<%= id %>-container");
                            if(wrapper){
                                wrapper.innerHTML = "";
                            }

                            const omnilwc = document.createElement('<%= omniscriptElement%>'),
                                prefill = "<%= prefill%>",
                                layout = "<%= layout%>",
                                useLocalScriptDef = "<%=useLocalDefProp%>" === 'true';

                            omnilwc.setAttribute("layout", layout === 'newport' ? 'newport' : '');

                            if(prefill){
                                omnilwc.setAttribute("prefill", prefill);
                            }

                            if(useLocalScriptDef) {
								omnilwc.setAttribute("run-mode", "localScriptDef");
                            }

                            wrapper.appendChild(omnilwc);
                        }

                        addElement<%= id%>();
                    </script>
                    <% } %>
                </body>
            </html>
        <%
    } else {
        %>No Cloud Configuration Found: Please ask you administrator to check your Salesforce Cloud Services Configuration<%
    }
%>