% A local function `dbl` in main.m should shadow the workspace `dbl.m`.
disp(dbl(5));

function y = dbl(x)
  y = x + 100;
end
