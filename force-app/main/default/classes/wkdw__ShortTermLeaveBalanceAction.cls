/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class ShortTermLeaveBalanceAction {
    global ShortTermLeaveBalanceAction() {

    }
    @InvocableMethod(label='Get Short Term Leave' description='Invokes the Workday API methods in order to fetch short term leave balance details for a Employee')
    global static List<wkdw.ShortTermLeaveBalanceAction.RequestOutput> getShortTermLeaveBalance(List<wkdw.ShortTermLeaveBalanceAction.RequestInput> workdayShortTermLeaveRequestInputs) {
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
    global Boolean isSuccess;
    @InvocableVariable( required=false)
    global String timeOffBalanceData;
    global RequestOutput() {

    }
}
}
