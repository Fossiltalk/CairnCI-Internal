import { LightningElement, wire, api, track } from 'lwc';
import getUserId from '@salesforce/apex/getRecordId.getUserId'
export default class InAppLanding extends LightningElement {
    @api welcome_text = "";
    @api no_user = false;

    userId;
    userURL;

    connectedCallback(){

        getUserId().then(result => {
            console.log("User ID: ", result);
            if (result.length) {
                this.userId = result[0].Id;
                this.userURL = "/lightning/setup/ManageUsers/page?address=/" + this.userId + "?noredirect=1&isUserEntityOverride=1";
            } else{
                this.no_user = true;
                this.userURL = "fakeURL";
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