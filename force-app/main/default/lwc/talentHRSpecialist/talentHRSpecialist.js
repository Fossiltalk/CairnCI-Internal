import { LightningElement, wire, api, track } from 'lwc';
import getAppFormId from '@salesforce/apex/getRecordId.getAppFormId'
export default class InAppLanding extends LightningElement {
    @api welcome_text = "";
    @api no_appForm = false;

    appFormId;
    
    connectedCallback(){

        getAppFormId().then(result => {
            console.log("User ID: ", result);
            if (result.length) {
                this.appFormId = result[0].Id;
            } else{
                this.no_appForm = true;
            }
        });

    }

    get pass_false() {
        return false;
    }

    get pass_true() {
        return true;
    }

}