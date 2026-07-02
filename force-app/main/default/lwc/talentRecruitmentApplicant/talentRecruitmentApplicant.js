import { LightningElement, wire, api, track } from 'lwc';
import getPersonAccountId from '@salesforce/apex/getRecordId.getPersonAccountId'

export default class InAppLanding extends LightningElement {
    @api welcome_text = "";
    @api no_account = false;

    accountId;

    connectedCallback() {
        getPersonAccountId()
        .then(result => {
            console.log("Account ID", result);
            if (result.length) {
                this.accountId = result[0].Id;
            } else {
                this.no_account = true;
                this.accountId = ""
            }
        })
    }  

    get pass_false() {
        return false;
    }

    get pass_true() {
        return true;
    }

}