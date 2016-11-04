module.exports = {
   set_bookmark: (state, model)=>{
       console.log(model);
        state.dispatch("SET_BOOKMARK", model);
   }
};