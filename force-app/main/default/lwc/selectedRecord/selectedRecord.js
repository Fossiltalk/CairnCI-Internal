import { LightningElement,api } from 'lwc';

export default class SelectedRecord extends LightningElement {
    @api recordid;
    @api recordname;
    @api rolevalue;
    @api statusvalue;
    @api rolepicklist;
    @api statuspicklist;

    sendDataUpdatedEvent() {
        console.log(`inside sendDataUpdatedEvent: ${this.recordid} : ${this.rolevalue} + ${this.statusvalue}`);
        const recordChangedEvent = new CustomEvent('recordchanged', {
            // detail contains new values
            detail: {
                "id":this.recordid,
                "role":this.rolevalue,
                "status":this.statusvalue
            }
        });
        this.dispatchEvent(recordChangedEvent);
    }

    handleRoleChange(event) {
        this.rolevalue = event.detail.value;
        console.log("inside selectedRecord handleRoleChange");
        this.sendDataUpdatedEvent();
    }

    handleStatusChange(event) {
        this.statusvalue = event.detail.value;
        console.log("inside selectedRecord handleStatusChange");
        this.sendDataUpdatedEvent();
    }

    onDeleteClick() {
        console.log('onDeleteClick recordid: ' + this.recordid);
        const event = new CustomEvent('deleterecord', {
            // detail contains id
            detail: this.recordid
        });
        this.dispatchEvent(event);
    }
}