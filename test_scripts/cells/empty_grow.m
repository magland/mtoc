% Empty cell, then grow via literal-index writes. Numbl auto-grows
% cells on literal-index assignment; mtoc tracks the same pattern.
% The pre-pass marks the variable homogeneous because of the empty
% literal, and the Unknown elem on the empty cell widens to double
% on the first concrete c{k} = … write.
c = {};
c{1} = 10;
c{2} = 20;
c{3} = 30;
disp(c{1});
disp(c{2});
disp(c{3});
