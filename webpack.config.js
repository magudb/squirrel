var path = require("path");

var webpack = require("webpack");
var ExtractTextPlugin = require("extract-text-webpack-plugin");


module.exports = {
    output: {
        path: path.resolve(__dirname, "public/js"),
        filename: "app.js",

    },
    entry: {
        app: path.resolve(__dirname, "scripts/app.js")
    },
    module: {
        noParse: [
            /\/bindings\//,
            /\.md$/,
        ],
        loaders: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                loader: "babel",
                query: {
                    presets: ['es2015']
                }
            },
            {
                test: /\.s[ac]ss/,
                loader: ExtractTextPlugin.extract('style', 'css!sass')
            },
            {
                test: /\.html/,
                loader: "html"
            },
            {
                test: /\.(ttf|eot|svg|woff(2)?)(\?[a-z0-9]+)?$/,
                loader: 'file-loader'
            },
            { test: /\.hbs$/, loader: "handlebars-loader" },
            {
                test: /\.json$/,
                loader: 'json-loader'
            },

        ]
    },
    plugins: [
        new webpack.optimize.CommonsChunkPlugin(/* chunkName= */'vendor', /* filename= */'vendor.js', function (module) {
            return module.resource && module.resource.indexOf('node_modules') !== -1;
        }),
        new webpack.ContextReplacementPlugin(/bindings$/, /^$/),
        new webpack.optimize.OccurenceOrderPlugin(),
        new webpack.optimize.DedupePlugin(),
        new ExtractTextPlugin('../css/bundle.css', {
            allChunks: true
        })

    ]
};