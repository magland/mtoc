% A string variable assigned only inside an if-arm (with no else):
% the env-merge at end-of-if must accept it as a String. (Before the
% fix it tried to unify String with the numeric zero-default and
% threw "incompatible types across the arms" at lowering.)
cond = 1;
if cond > 0
  msg = "branch fired";
end
disp(msg);
