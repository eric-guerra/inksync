const path = require('path');

module.exports = {
  entry: './client/main.jsx',
  output: { path: path.resolve(__dirname, 'public/build'), filename: 'bundle.js' },
  resolve: { extensions: ['.js', '.jsx'] },
  module: {
    rules: [{
      test: /\.jsx?$/,
      exclude: /node_modules/,
      use: { loader: 'babel-loader', options: { presets: ['@babel/preset-env', '@babel/preset-react'] } }
    }]
  },
  devtool: 'source-map'
};
