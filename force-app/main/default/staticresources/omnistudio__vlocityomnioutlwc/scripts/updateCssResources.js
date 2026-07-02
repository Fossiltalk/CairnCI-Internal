
const fs = require("fs");
const data = "#base=css";

fs.writeFile("aem.ui.apps/src/main/content/jcr_root/apps/vloclwc/clientlibs/vlocity-lwc/css.txt", data, (err) => {
  if (err) console.log(err);
  console.log("Successfully Written to File. => css.txt");
});