% Tuple cell with slot reassignment via c{k} = ...
c = {1, 2, 3};
c{2} = 42;
disp(c{1});
disp(c{2});
disp(c{3});
