/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class DirectDepositStatusAction {
    global DirectDepositStatusAction() {

    }
    @InvocableMethod(label='Get Direct Deposit Details' description='Invokes the Workday API methods in order to check if the bank account is present')
    global static List<wkdw.DirectDepositStatusAction.RequestOutput> getDirectDepositDetails(List<wkdw.DirectDepositStatusAction.RequestInput> workdayDirectDepositRequestInputs) {
        return null;
    }
global class RequestInput {
    @InvocableVariable( required=false)
    global String employeeReference;
    global RequestInput() {

    }
}
global class RequestOutput {
    @InvocableVariable( required=false)
    global String errorMessage;
    @InvocableVariable( required=false)
    global String hasBankAccount;
    @InvocableVariable( required=false)
    global Boolean isSuccess;
    @InvocableVariable( required=false)
    global Integer total_Bank_Accounts;
    global RequestOutput() {

    }
}
}
