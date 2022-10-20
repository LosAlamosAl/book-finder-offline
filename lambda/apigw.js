exports.handler = async (event, context) => {
  console.log("If we made it here, we're authorized");
  console.log(JSON.stringify(event));
  console.log(JSON.stringify(context));
  console.log(JSON.stringify(process.env));

  let ret = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: "WTF, man?"
  };

  return ret;
};
